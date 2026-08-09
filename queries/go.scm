; Tag query for Go.
;
; Visibility comes from capitalisation, handled in extract.ts.
;
; Imports are not captured: Go resolves within a package rather than per file,
; so same-file scope plus project-unique names already covers most calls.

; --- functions ---------------------------------------------------------------

(function_declaration
  name: (identifier) @name) @definition.function

(method_declaration
  name: (field_identifier) @name) @definition.method

; --- types -------------------------------------------------------------------

; The definition is captured on the type_spec, not on the type_declaration that
; wraps it: a grouped `type ( A …; B … )` is one declaration holding several
; specs, and anchoring on it gives every type in the group the whole block as
; its range.
(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (struct_type)) @definition.class)

(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (interface_type)) @definition.interface)

(type_declaration
  (type_spec
    name: (type_identifier) @name) @definition.type)

; --- values ------------------------------------------------------------------

(const_spec
  name: (identifier) @name) @definition.constant

(var_spec
  name: (identifier) @name) @definition.constant

; --- call sites --------------------------------------------------------------

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (selector_expression
    field: (field_identifier) @name)) @reference.method
