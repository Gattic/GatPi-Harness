#!/usr/bin/env python3
"""Small, polite technical SEO sampler (stdlib-only; no authentication).

Offline static HTML audit:
  python site_audit.py --html-dir ./exported-site --out /tmp/seo-report.json

Authorized, bounded public-site crawl:
  python site_audit.py --url https://example.com/ --max-pages 40 --delay 0.75 \
      --out /tmp/seo-report.json

This is not Search Console or a rendered-browser crawl. It cannot establish
actual indexation, Google rankings, crawl budget, JS-rendered content or traffic.
It does not execute JavaScript or submit forms. Never use on an unauthorized site.
"""
from __future__ import annotations

import argparse
import collections
import html
import ipaddress
import json
import pathlib
import re
import socket
import sys
import time
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urldefrag, urljoin, urlparse, urlunparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.robotparser import RobotFileParser

AGENT='SkillFoundrySEOAudit/1.0 (+single-origin; respects robots.txt)'
MAX_RESPONSE_BYTES=1_500_000


class SafeRedirect(HTTPRedirectHandler):
    def __init__(self, origin: str):
        super().__init__()
        self.origin=origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        p=urlparse(newurl)
        if p.scheme not in ('https','http') or p.netloc.lower()!=urlparse(self.origin).netloc.lower():
            raise ValueError('Redirect would leave audited origin; refused')
        return super().redirect_request(req,fp,code,msg,headers,newurl)


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title=[]
        self.in_title=False
        self.in_h1=False
        self.h1=[]
        self.active_h1=[]
        self.meta={}
        self.canonical=[]
        self.hreflang=[]
        self.links=[]
        self.images=0
        self.missing_alt=0
        self.html_lang=None
        self.structured_data=0

    def handle_starttag(self, tag, attrs):
        d={k.lower():v for k,v in attrs if k is not None}
        if tag=='html':
            self.html_lang=d.get('lang')
        elif tag=='title':
            self.in_title=True
        elif tag=='h1':
            self.in_h1=True
            self.active_h1=[]
        elif tag=='meta':
            key=(d.get('name') or d.get('property') or '').lower()
            if key:
                # HTMLParser uses None for an attribute present without a value.
                self.meta[key]=d.get('content') or ''
        elif tag=='link':
            rel=(d.get('rel') or '').lower().split()
            if 'canonical' in rel:
                self.canonical.append(d.get('href',''))
            if 'alternate' in rel and d.get('hreflang'):
                self.hreflang.append((d['hreflang'],d.get('href','')))
        elif tag=='a':
            if d.get('href'):
                self.links.append(d['href'])
        elif tag=='img':
            self.images+=1
            if not d.get('alt') and 'alt' not in d:
                self.missing_alt+=1
        elif tag=='script' and (d.get('type') or '').lower()=='application/ld+json':
            self.structured_data+=1

    def handle_endtag(self, tag):
        if tag=='title':
            self.in_title=False
        elif tag=='h1' and self.in_h1:
            self.in_h1=False
            self.h1.append(' '.join(''.join(self.active_h1).split()))

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)
        if self.in_h1:
            self.active_h1.append(data)


def check_public_dns(hostname: str):
    # Prevent accidental crawling of internal interfaces or loopback services.
    if hostname.lower() in ('localhost','localhost.localdomain'):
        raise ValueError('Only public hostnames are allowed in --url mode')
    addresses={info[4][0] for info in socket.getaddrinfo(hostname,None,type=socket.SOCK_STREAM)}
    for value in addresses:
        address=ipaddress.ip_address(value)
        if not address.is_global:
            raise ValueError(f'Address {value} for target is not globally routable')


def normalize_url(url: str) -> str:
    p=urlparse(urldefrag(url)[0])
    normalized_path=re.sub(r'/+','/',p.path or '/')
    return urlunparse((p.scheme.lower(),p.netloc.lower(),normalized_path,'',p.query,''))


def make_result(path: str, raw: str, status: int, url: str|None=None) -> dict:
    parser=PageParser()
    parser.feed(raw)
    title=' '.join(''.join(parser.title).split())
    return {
        'path':path,'url':url,'status':status,'title':title,
        'description':parser.meta.get('description',''),
        'h1':parser.h1,'html_lang':parser.html_lang,
        'canonical':parser.canonical,'meta_robots':parser.meta.get('robots',''),
        'hreflang':parser.hreflang,'links':parser.links,
        'image_count':parser.images,'missing_alt_count':parser.missing_alt,
        'jsonld_script_count':parser.structured_data,'issues':[],
    }


def audit_page(result: dict):
    issues=[]
    if result['status']>=400:
        issues.append(f'HTTP_{result["status"]}')
    if not result['title']:
        issues.append('MISSING_TITLE')
    if not result['description']:
        issues.append('MISSING_META_DESCRIPTION')
    if len(result['h1'])==0:
        issues.append('MISSING_H1')
    elif len(result['h1'])>1:
        issues.append('MULTIPLE_H1_REVIEW_CONTEXT')
    if not result['html_lang']:
        issues.append('MISSING_HTML_LANG')
    if len(result['canonical'])>1:
        issues.append('MULTIPLE_CANONICAL_TAGS')
    if not result['canonical']:
        issues.append('NO_DECLARED_CANONICAL_REVIEW_CONTEXT')
    if result['missing_alt_count']:
        issues.append('IMAGES_MISSING_ALT_ATTRIBUTE')
    if 'noindex' in result['meta_robots'].lower():
        issues.append('NOINDEX_PRESENT_REVIEW_IF_INTENTIONAL')
    result['issues']=issues


def audit_local(root: pathlib.Path, max_pages: int) -> list[dict]:
    if not root.is_dir():
        raise ValueError(f'HTML directory not found: {root}')
    files=sorted(set(root.rglob('*.html')) | set(root.rglob('*.htm')))[:max_pages]
    results=[]
    for p in files:
        try:
            body=p.read_text(encoding='utf-8',errors='replace')
            result=make_result(str(p.relative_to(root)),body,200)
            audit_page(result)
            results.append(result)
        except OSError as exc:
            results.append({'path':str(p.relative_to(root)),'issues':['UNREADABLE_FILE'],
                            'error':str(exc)})
    return results


def get_robots(opener, base: str) -> RobotFileParser:
    url=urljoin(base,'/robots.txt')
    req=Request(url,headers={'User-Agent':AGENT},method='GET')
    try:
        with opener.open(req,timeout=12) as resp:
            if resp.status>=400:
                raise RuntimeError(f'Robots fetch status {resp.status}')
            data=resp.read(300000).decode('utf-8','replace')
    except HTTPError as exc:
        if exc.code in (404,410):
            data='User-agent: *\nAllow: /\n'
        else:
            raise RuntimeError(f'Robots request failed; crawl stopped ({exc.code})') from exc
    parser=RobotFileParser()
    parser.parse(data.splitlines())
    return parser


def audit_public(url: str, max_pages: int, delay: float) -> list[dict]:
    start=normalize_url(url)
    p=urlparse(start)
    if p.scheme not in ('https','http') or not p.hostname:
        raise ValueError('--url requires a public HTTP(S) URL')
    check_public_dns(p.hostname)
    origin=f'{p.scheme}://{p.netloc}'
    opener=build_opener(SafeRedirect(origin))
    robots=get_robots(opener,origin)
    pending=collections.deque([start])
    seen=set()
    results=[]
    while pending and len(results)<max_pages:
        current=pending.popleft()
        if current in seen:
            continue
        seen.add(current)
        if not robots.can_fetch(AGENT,current):
            results.append({'url':current,'path':urlparse(current).path,'issues':['ROBOTS_DISALLOWED'],
                            'status':None,'links':[]})
            continue
        req=Request(current,headers={'User-Agent':AGENT,'Accept':'text/html'},method='GET')
        try:
            with opener.open(req,timeout=15) as resp:
                content_type=(resp.headers.get('Content-Type') or '').lower()
                status=resp.status
                final_url=normalize_url(resp.geturl())
                if final_url not in seen:
                    seen.add(final_url)
                if 'text/html' not in content_type:
                    results.append({'url':current,'path':urlparse(current).path,
                                    'status':status,'links':[],'issues':['NON_HTML_RESOURCE']})
                    continue
                raw=resp.read(MAX_RESPONSE_BYTES+1)
                if len(raw)>MAX_RESPONSE_BYTES:
                    results.append({'url':current,'path':urlparse(current).path,
                                    'status':status,'links':[],'issues':['RESPONSE_TOO_LARGE']})
                    continue
                encoding=resp.headers.get_content_charset() or 'utf-8'
                body=raw.decode(encoding,errors='replace')
                result=make_result(urlparse(current).path,body,status,current)
                audit_page(result)
                if final_url!=current:
                    result['issues'].append('REDIRECTED_REVIEW_TARGET')
                    result['final_url']=final_url
                results.append(result)
                for href in result['links']:
                    next_url=normalize_url(urljoin(current,href))
                    q=urlparse(next_url)
                    if q.scheme in ('http','https') and q.netloc.lower()==p.netloc.lower() and next_url not in seen:
                        pending.append(next_url)
        except (HTTPError,URLError,ValueError,OSError) as exc:
            code=exc.code if isinstance(exc,HTTPError) else None
            results.append({'url':current,'path':urlparse(current).path,
                            'status':code,'links':[],'issues':['FETCH_FAILED'],
                            'error':str(exc)[:350]})
        finally:
            time.sleep(delay)
    return results


def summarize(results: list[dict], mode: str) -> dict:
    titles=collections.defaultdict(list)
    for result in results:
        if result.get('title'):
            titles[result['title'].casefold()].append(result)
    for title,group in titles.items():
        if len(group)>1:
            for item in group:
                item['issues'].append('DUPLICATE_TITLE_IN_SAMPLE')
    counts=collections.Counter(issue for result in results for issue in result['issues'])
    return {
        'mode':mode,'page_count':len(results),'issue_counts':dict(sorted(counts.items())),
        'caveats':['Sampling, not indexation evidence','HTML parsing only; JavaScript not executed',
                   'Intentional noindex/404/multiple H1 requires human context',
                   'Check actual Search Console, rendered DOM and canonical targets before prioritizing'],
        'pages':results,
    }


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    source=parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--html-dir',type=pathlib.Path)
    source.add_argument('--url')
    parser.add_argument('--max-pages',type=int,default=30)
    parser.add_argument('--delay',type=float,default=0.75)
    parser.add_argument('--out',type=pathlib.Path,required=True)
    args=parser.parse_args()
    if not 1<=args.max_pages<=200:
        parser.error('--max-pages must be 1..200')
    if args.delay<0.25:
        parser.error('--delay must be >= 0.25 seconds')
    try:
        if args.html_dir:
            mode='offline-static-html'
            results=audit_local(args.html_dir.resolve(),args.max_pages)
        else:
            mode='authorized-public-origin-crawl'
            results=audit_public(args.url,args.max_pages,args.delay)
        report=summarize(results,mode)
        out=args.out.expanduser().resolve()
        out.parent.mkdir(parents=True,exist_ok=True)
        out.write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
        print(f"Inspected {len(results)} pages; {sum(report['issue_counts'].values())} issue signals; report: {out}")
        return 0
    except (OSError,ValueError,RuntimeError) as exc:
        print(f'ERROR: {exc}',file=sys.stderr)
        return 2


if __name__=='__main__':
    sys.exit(main())
