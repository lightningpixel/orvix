; Tag query for C++, shared with C.
;
; A C file produces a subset of these tags — it has no class_specifier and no
; qualified_identifier — so one query serves both.
;
; Only definitions are tagged. A member declared inside a class body is a
; `field_declaration`, not a `function_definition`, so the declaration in the
; header and the definition in the source do not become two symbols; the
; definition alone is indexed.
;
; Includes are not captured: `#include "a.h"` names a header, and the symbol it
; declares is defined elsewhere, so following it would point at the wrong file.

; --- functions ---------------------------------------------------------------

(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @definition.function

; `int Service::run() { … }` sits outside the class, so containment cannot make
; it a method. Tagged as one directly, and under `run` rather than
; `Service::run`, or a receiver call could never reach it.
(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier
      name: (identifier) @name))) @definition.method

; Defined inline in the class body. The grammar calls the name a
; field_identifier there rather than an identifier, and that node type occurs
; nowhere else, so the match is a method by construction.
(function_definition
  declarator: (function_declarator
    declarator: (field_identifier) @name)) @definition.method

; --- types -------------------------------------------------------------------

(class_specifier
  name: (type_identifier) @name) @definition.class

(struct_specifier
  name: (type_identifier) @name) @definition.class

(union_specifier
  name: (type_identifier) @name) @definition.class

(enum_specifier
  name: (type_identifier) @name) @definition.enum

(type_definition
  declarator: (type_identifier) @name) @definition.type

(namespace_definition
  name: (namespace_identifier) @name) @definition.type

; --- call sites --------------------------------------------------------------

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (qualified_identifier
    name: (identifier) @name)) @reference.call

(call_expression
  function: (field_expression
    field: (field_identifier) @name)) @reference.method
