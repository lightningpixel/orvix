; Tag query for TypeScript.
;
; Every definition pattern captures the whole declaration as @definition.<kind>
; and its identifier as @name. Overlapping patterns are expected: a
; `const f = () => {}` matches both the function and the constant pattern, and
; extract.ts keeps the more specific kind.

; --- functions ---------------------------------------------------------------

(function_declaration
  name: (identifier) @name) @definition.function

(generator_function_declaration
  name: (identifier) @name) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function

; --- classes and their members -----------------------------------------------

(class_declaration
  name: (type_identifier) @name) @definition.class

(abstract_class_declaration
  name: (type_identifier) @name) @definition.class

(method_definition
  name: (property_identifier) @name) @definition.method

(abstract_method_signature
  name: (property_identifier) @name) @definition.method

; --- types -------------------------------------------------------------------

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(method_signature
  name: (property_identifier) @name) @definition.method

(type_alias_declaration
  name: (type_identifier) @name) @definition.type

(enum_declaration
  name: (identifier) @name) @definition.enum

; --- values ------------------------------------------------------------------

(lexical_declaration
  (variable_declarator
    name: (identifier) @name)) @definition.constant

; --- call sites --------------------------------------------------------------

; A bare call and a call through a receiver are tagged apart: `parse(x)` can
; only reach a function, `JSON.parse(x)` can only reach a method. Collapsing
; the two makes every `.parse()` in the project look like a call to any
; function named parse.

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name)) @reference.method

(new_expression
  constructor: (identifier) @name) @reference.call

; --- imports -----------------------------------------------------------------

(import_statement) @import
