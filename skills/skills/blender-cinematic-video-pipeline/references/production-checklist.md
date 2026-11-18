# Blender animated video delivery: evidence-driven checklist

- **Brief**: subject, look, seconds timeline, camera, physics/constraints, dimensions, fps, audio, platform, license restrictions.
- **Environment**: `blender --version`, `ffmpeg -version`, probe GPU device by Blender preferences and logs, check writable workspace/space and render budget. Background mode isn't proof of GPU rendering.
- **Asset chain**: record texture/material/source rights; do not assume any internet model or sound is permitted.
- **Preview**: scene save -> hero frame -> start/key/extreme/end frames -> contact sheet -> full-duration low-quality playblast -> final frames.
- **Physics**: check measured contact/clearance for key moments and sampled motion; image realism is not physical certification.
- **Encode**: use source frame rate, duration and codec target. A portable social example may use H.264/yuv420p/AAC, but target requirements supersede defaults. Probe output with ffprobe and decode representative frames.
- **Delivery**: video, `.blend`, scripts, dependencies, logs, contact sheet, metadata, actual measured compute time/cost if available.
- **Honesty**: no fake render/device results, no arbitrary mandatory three rounds, no sound classification by spectrogram alone.

Source: https://gist.github.com/ivanfioravanti/1b892d8d30db8703c113dc56d6bbf11d
