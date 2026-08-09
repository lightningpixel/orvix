; Tag query for C#.
;
; Access is written on each member, so extract.ts reads it from the `modifier`
; children rather than inferring it from the enclosing type. Unlike Java, the
; modifiers are repeated siblings rather than one `modifiers` node.
;
; Imports are not captured: `using App.Services` names a namespace, and a
; namespace maps to no particular file. Calls resolve through same-file scope
; and project-unique names.

; --- types -------------------------------------------------------------------

(class_declaration
  name: (identifier) @name) @definition.class

(record_declaration
  name: (identifier) @name) @definition.class

(struct_declaration
  name: (identifier) @name) @definition.class

(interface_declaration
  name: (identifier) @name) @definition.interface

(enum_declaration
  name: (identifier) @name) @definition.enum

(delegate_declaration
  name: (identifier) @name) @definition.type

; --- members -----------------------------------------------------------------

(method_declaration
  name: (identifier) @name) @definition.method

; Constructors are deliberately not tagged, for the same reason as java.scm:
; one carries its class's name, so a symbol for it makes every `new S()`
; ambiguous with the class and no edge is drawn.

; A property is read like a field and never called, so it is a value rather
; than a method — the kind decides what a receiver call may reach.
(property_declaration
  name: (identifier) @name) @definition.constant

(field_declaration
  (variable_declaration
    (variable_declarator
      (identifier) @name))) @definition.constant

; --- call sites --------------------------------------------------------------

; Kept apart by receiver, as in typescript.scm: without it every `list.Add(…)`
; would reach any method named Add.

(invocation_expression
  function: (identifier) @name) @reference.call

(invocation_expression
  function: (member_access_expression
    name: (identifier) @name)) @reference.method

(object_creation_expression
  type: (identifier) @name) @reference.call
