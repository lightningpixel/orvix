; Tag query for JavaScript.
;
; The same shape as typescript.scm, minus the type-level constructs, and with
; class names as (identifier) rather than (type_identifier).

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
  name: (identifier) @name) @definition.class

(method_definition
  name: (property_identifier) @name) @definition.method

; --- values ------------------------------------------------------------------

; Anchored on the lexical_declaration for the same reason as typescript.scm:
; the signature keeps its keyword, at the cost of `const a = 1, b = 2` sharing
; one range.
(lexical_declaration
  (variable_declarator
    name: (identifier) @name)) @definition.constant

; --- call sites --------------------------------------------------------------

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name)) @reference.method

(new_expression
  constructor: (identifier) @name) @reference.call

; --- imports -----------------------------------------------------------------

(import_statement) @import
