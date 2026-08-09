; Tag query for Python.
;
; There is no distinct node type for a method: a def inside a class body is a
; plain function_definition, and extract.ts promotes it based on containment.
;
; Imports are not captured. Python's import system is name-based rather than
; path-based, so an accurate mapping would need per-package resolution; calls
; still resolve through same-file scope and project-unique names.

; --- definitions -------------------------------------------------------------

(function_definition
  name: (identifier) @name) @definition.function

(class_definition
  name: (identifier) @name) @definition.class

; Module-level assignments. The `(module ...)` context restricts the match to
; the top level, but the definition capture belongs on the assignment: anchored
; on the module it would give every constant the whole file as its range, and
; `show` would print the file instead of the line.
(module
  (expression_statement
    (assignment
      left: (identifier) @name) @definition.constant))

; --- call sites --------------------------------------------------------------

(call
  function: (identifier) @name) @reference.call

(call
  function: (attribute
    attribute: (identifier) @name)) @reference.method
