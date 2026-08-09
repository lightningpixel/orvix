; Tag query for Java.
;
; Unlike Python and Go, Java has a distinct node for a method, so methods are
; tagged directly rather than promoted from containment.
;
; Imports are not captured. `import com.example.Bar` names a package rather
; than a path, and mapping one to a file needs the source root, which the
; indexer does not know; calls still resolve through same-file scope and
; project-unique names.

; --- types -------------------------------------------------------------------

(class_declaration
  name: (identifier) @name) @definition.class

(record_declaration
  name: (identifier) @name) @definition.class

(interface_declaration
  name: (identifier) @name) @definition.interface

(enum_declaration
  name: (identifier) @name) @definition.enum

(annotation_type_declaration
  name: (identifier) @name) @definition.interface

; --- members -----------------------------------------------------------------

(method_declaration
  name: (identifier) @name) @definition.method

(constructor_declaration
  name: (identifier) @name) @definition.method

; A field, anchored on the declaration so the signature keeps its modifiers and
; type. `int a = 1, b = 2` therefore gives a and b one range, the same trade-off
; typescript.scm records; the form is rare and the keyword is worth more.
(field_declaration
  declarator: (variable_declarator
    name: (identifier) @name)) @definition.constant

; --- call sites --------------------------------------------------------------

; A receiver means a method is being called, a bare name means one defined in
; scope. Kept apart for the same reason as typescript.scm: without it every
; `list.get(…)` in a project reaches any method named get.

(method_invocation
  object: (_)
  name: (identifier) @name) @reference.method

(method_invocation
  !object
  name: (identifier) @name) @reference.call

(object_creation_expression
  type: (type_identifier) @name) @reference.call
