import LeanChecker.Replay
import Lean.Util.CollectAxioms

open Lean

-- This process never elaborates candidate source, loads its plugins, or runs its
-- initializers. It replays its serialized declarations through the kernel.
unsafe def main (args : List String) : IO UInt32 := do
  let [target, theoremName, imports, axioms] := args
    | throw <| IO.userError "invalid checker arguments"
  initSearchPath (← findSysroot)
  searchPathRef.modify (System.FilePath.mk "/workspace" :: ·)
  let reference ← importModules #[{ module := `Expected }] {} 0 (loadExts := false)
  let some expected := reference.find? target.toName
    | throw <| IO.userError "target declaration missing"
  let mut files := #[System.FilePath.mk "/workspace/Candidate.olean"]
  for suffix in [".server", ".private"] do
    let file := System.FilePath.mk ("/workspace/Candidate.olean" ++ suffix)
    if ← file.pathExists then files := files.push file
  let parts ← readModuleDataParts files
  let some (header, _) := parts[0]?
    | throw <| IO.userError "empty candidate module"
  let allowedImports := imports.splitOn ","
  let referenceParts ← readModuleDataParts #[System.FilePath.mk "/workspace/Expected.olean"]
  let some (referenceHeader, _) := referenceParts[0]?
    | throw <| IO.userError "empty reference module"
  for moduleHeader in [header, referenceHeader] do
    let actualImports := moduleHeader.imports.toList.map (·.module.toString)
    unless actualImports.all allowedImports.contains && allowedImports.all actualImports.contains do
      throw <| IO.userError s!"unapproved import set: {actualImports}"
  let env ← importModules header.imports {} 0 (loadExts := false)
  let mut constants := {}
  let some (last, _) := parts[parts.size - 1]?
    | throw <| IO.userError "missing candidate declarations"
  for name in last.constNames, ci in last.constants do
    constants := constants.insert name ci
  let checked ← env.replay' constants
  -- Replay returns a raw kernel environment, without elaborator async entries.
  let some (.thmInfo actual) := checked.toKernelEnv.find? theoremName.toName
    | throw <| IO.userError s!"candidate theorem missing: {theoremName}"
  unless constants.contains theoremName.toName do
    throw <| IO.userError "candidate must define the theorem"
  unless actual.type == expected.type && actual.levelParams == expected.levelParams do
    throw <| IO.userError "target proposition mismatch"
  let (_, state) := ((CollectAxioms.collect theoremName.toName).run checked).run {}
  let allowedAxioms := axioms.splitOn ","
  for axiomName in state.axioms do
    unless allowedAxioms.contains axiomName.toString do
      throw <| IO.userError s!"unapproved axiom: {axiomName}"
  IO.println "PI_LEAN_KERNEL_ACCEPTED"
  return 0
