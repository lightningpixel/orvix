; Tag query for Rust.
;
; Visibility comes from a `pub` modifier, handled in extract.ts.
;
; Functions inside an `impl` block are reported as functions rather than
; methods: an impl block is not itself a definition, so there is no container
; to attribute them to. Their names still resolve.
;
; `use` declarations are not captured; calls resolve through same-file scope
; and project-unique names.

; --- functions ---------------------------------------------------------------

(function_item
  name: (identifier) @name) @definition.function

; --- types -------------------------------------------------------------------

(struct_item
  name: (type_identifier) @name) @definition.class

(enum_item
  name: (type_identifier) @name) @definition.enum

(trait_item
  name: (type_identifier) @name) @definition.interface

(type_item
  name: (type_identifier) @name) @definition.type

(mod_item
  name: (identifier) @name) @definition.type

; --- values ------------------------------------------------------------------

(const_item
  name: (identifier) @name) @definition.constant

(static_item
  name: (identifier) @name) @definition.constant

; --- call sites --------------------------------------------------------------

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (scoped_identifier
    name: (identifier) @name)) @reference.call

(call_expression
  function: (field_expression
    field: (field_identifier) @name)) @reference.method
