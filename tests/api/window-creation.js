"use strict";
const assert = require("node:assert/strict");
const { describe, it } = require("mocha-sugar-free");

const { JSDOM } = require("../..");
const jsGlobals = require("../../src/generated/js-globals.json");

const configurations = {
  "without runScripts": {},
  "with runScripts: \"outside-only\"": { runScripts: "outside-only" },
  "with runScripts: \"dangerously\"": { runScripts: "dangerously" }
};

describe("API: window creation", () => {
  for (const [configName, options] of Object.entries(configurations)) {
    describe(configName, () => {
      it("should install the JavaScript globals as own data properties with the expected attributes", () => {
        const { window } = new JSDOM(``, options);

        for (const [name, expected] of Object.entries(jsGlobals)) {
          if (!(name in globalThis)) {
            continue;
          }
          const desc = Object.getOwnPropertyDescriptor(window, name);
          assert.ok(desc, name);
          assert.ok("value" in desc, `${name} should be a data property`);
          assert.equal(desc.writable, expected.writable, `${name} writable`);
          assert.equal(desc.enumerable, expected.enumerable, `${name} enumerable`);
          assert.equal(desc.configurable, expected.configurable, `${name} configurable`);

          if (options.runScripts) {
            // The value seen from the outside is the one that scripts inside the window see.
            const inside = window.eval(name);
            if (Number.isNaN(inside)) {
              assert.ok(Number.isNaN(desc.value), name);
            } else {
              assert.equal(desc.value, inside, name);
            }
          } else {
            assert.equal(desc.value, globalThis[name], name);
          }
        }
      });

      it("should give each window its own JavaScript globals when running scripts", () => {
        const window1 = new JSDOM(``, options).window;
        const window2 = new JSDOM(``, options).window;

        if (options.runScripts) {
          assert.notEqual(window1.Object, window2.Object);
          assert.notEqual(window1.Array, window2.Array);
          assert.equal(Object.getPrototypeOf(window1.EventTarget.prototype), window1.Object.prototype);
        } else {
          assert.equal(window1.Object, Object);
        }
      });

      it("should have the expected prototype chain", () => {
        const { window } = new JSDOM(``, options);

        assert.equal(Object.getPrototypeOf(window), window.Window.prototype);
        assert.equal(Object.prototype.toString.call(window), "[object Window]");
        assert.ok(window instanceof window.EventTarget);
        assert.ok(window instanceof window.Object);
        assert.equal(typeof window.hasOwnProperty, "function");
        assert.ok(Object.hasOwn(window, "document"));
      });

      it("should install interface objects as own, writable, configurable, non-enumerable data properties", () => {
        const { window } = new JSDOM(``, options);

        const names = [
          "EventTarget", "Node", "Element", "HTMLElement", "HTMLDivElement", "CSSStyleDeclaration", "DOMException",
          "Document"
        ];
        for (const name of names) {
          const desc = Object.getOwnPropertyDescriptor(window, name);
          assert.ok(desc, name);
          assert.equal(typeof desc.value, "function", name);
          assert.equal(desc.writable, true, name);
          assert.equal(desc.enumerable, false, name);
          assert.equal(desc.configurable, true, name);
          assert.ok(Object.getOwnPropertyNames(window).includes(name), name);
          assert.ok(name in window, name);
        }
      });

      it("should give interface objects and prototypes the shape Web IDL specifies", () => {
        const { window } = new JSDOM(``, options);

        // Constructible (EventTarget, Event, Document, HTMLDivElement) and non-constructible (Node, Element,
        // CharacterData, CSSStyleProperties) interfaces, with and without an inherited interface.
        const names = [
          "EventTarget", "Event", "Document", "HTMLDivElement", "Node", "Element", "CharacterData",
          "CSSStyleProperties"
        ];
        for (const name of names) {
          const I = window[name];
          assert.equal(I.name, name);
          assert.deepEqual(Object.getOwnPropertyNames(I).slice(0, 3), ["length", "name", "prototype"], name);
          assert.deepEqual(
            Object.getOwnPropertyDescriptor(I, "prototype"),
            { value: I.prototype, writable: false, enumerable: false, configurable: false },
            name
          );
          assert.deepEqual(
            Object.getOwnPropertyDescriptor(I.prototype, "constructor"),
            { value: I, writable: true, enumerable: false, configurable: true },
            name
          );
          assert.equal(Object.getOwnPropertyNames(I.prototype)[0], "constructor", name);
          assert.deepEqual(
            Object.getOwnPropertyDescriptor(I.prototype, Symbol.toStringTag),
            { value: name, writable: false, enumerable: false, configurable: true },
            name
          );
          assert.throws(() => I(), err => { // eslint-disable-line new-cap
            assert.equal(err.name, "TypeError");
            assert.equal(err.message, `Class constructor ${name} cannot be invoked without 'new'`);
            return true;
          }, name);
        }

        for (const name of ["Node", "Element", "CharacterData", "CSSStyleProperties"]) {
          assert.equal(window[name].length, 0, name);
          assert.throws(() => new window[name](), window.TypeError, name);
        }
        assert.equal(Object.getPrototypeOf(window.Node), window.EventTarget);
        assert.equal(Object.getPrototypeOf(window.Node.prototype), window.EventTarget.prototype);
        assert.equal(Object.getPrototypeOf(window.Element), window.Node);
        assert.equal(Object.getPrototypeOf(window.Element.prototype), window.Node.prototype);
        assert.equal(Object.getPrototypeOf(window.CSSStyleProperties.prototype), window.CSSStyleDeclaration.prototype);
        assert.ok(new window.Event("x") instanceof window.Event);

        // Members are enumerable, in the order of the IDL; operations are not constructors.
        assert.deepEqual(
          Object.getOwnPropertyNames(window.Node.prototype).slice(0, 6),
          ["constructor", "getRootNode", "hasChildNodes", "normalize", "cloneNode", "isEqualNode"]
        );
        const getter = Object.getOwnPropertyDescriptor(window.Node.prototype, "nodeType");
        assert.equal(getter.enumerable, true);
        assert.equal(getter.configurable, true);
        assert.equal(getter.get.name, "get nodeType");
        assert.equal(getter.set, undefined);
        const method = Object.getOwnPropertyDescriptor(window.Node.prototype, "appendChild");
        assert.equal(method.enumerable, true);
        assert.equal(method.writable, true);
        assert.equal(method.value.length, 1);
        assert.equal(Object.hasOwn(method.value, "prototype"), false);
        assert.throws(() => new method.value(), TypeError); // eslint-disable-line new-cap
        const property = Object.getOwnPropertyDescriptor(window.CSSStyleProperties.prototype, "backgroundColor");
        assert.equal(property.enumerable, true);
        assert.equal(property.set.name, "set backgroundColor");

        // Constants are on both the interface object and the prototype, after the other members.
        for (const object of [window.Node, window.Node.prototype]) {
          assert.deepEqual(
            Object.getOwnPropertyDescriptor(object, "ELEMENT_NODE"),
            { value: 1, writable: false, enumerable: true, configurable: false }
          );
        }
        const nodeKeys = Object.keys(window.Node.prototype);
        assert.equal(nodeKeys.indexOf("ELEMENT_NODE"), nodeKeys.length - 18);
      });

      it("should keep creating correct wrappers after an interface object is deleted or replaced", () => {
        const { window } = new JSDOM(``, options);
        const { HTMLDivElement, HTMLSpanElement } = window;

        assert.ok(delete window.HTMLDivElement);
        assert.equal(window.HTMLDivElement, undefined);
        assert.equal("HTMLDivElement" in window, false);

        Object.defineProperty(window, "HTMLSpanElement", { value: 42 });
        const desc = Object.getOwnPropertyDescriptor(window, "HTMLSpanElement");
        assert.deepEqual(desc, { value: 42, writable: true, enumerable: false, configurable: true });

        const div = window.document.createElement("div");
        const span = window.document.createElement("span");
        assert.equal(Object.getPrototypeOf(div), HTMLDivElement.prototype);
        assert.equal(Object.getPrototypeOf(span), HTMLSpanElement.prototype);
      });

      it("should create XPath objects that belong to their own window", () => {
        const window1 = new JSDOM(`<p>a</p><p>b</p>`, options).window;
        const window2 = new JSDOM(`<p>c</p>`, options).window;

        assert.notEqual(window1.XPathResult, window2.XPathResult);
        assert.notEqual(window1.Document.prototype.evaluate, window2.Document.prototype.evaluate);

        const result1 = window1.document.evaluate("count(//p)", window1.document, null, window1.XPathResult.ANY_TYPE);
        const result2 = window2.document.evaluate("count(//p)", window2.document, null, window2.XPathResult.ANY_TYPE);
        assert.ok(result1 instanceof window1.XPathResult);
        assert.ok(result2 instanceof window2.XPathResult);
        assert.equal(result1.numberValue, 2);
        assert.equal(result2.numberValue, 1);

        const expression = window1.document.createExpression("//p");
        const snapshot = expression.evaluate(window1.document, window1.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
        assert.equal(snapshot.snapshotLength, 2);
        assert.equal(snapshot.snapshotItem(1).textContent, "b");
      });

      it("should throw XPath errors that use the window's own XPathException constants", () => {
        const window1 = new JSDOM(``, options).window;
        const window2 = new JSDOM(``, options).window;

        assert.throws(() => window1.document.evaluate("//[", window1.document), err => {
          assert.equal(err.name, "XPathException");
          assert.equal(err.code, 51);
          return true;
        });

        window1.XPathException.INVALID_EXPRESSION_ERR = 99;
        window1.XPathException.TYPE_ERR = 98;

        assert.throws(() => window1.document.evaluate("//[", window1.document), { code: 99 });
        assert.throws(() => window1.document.evaluate("nosuchfunction()", window1.document), { code: 99 });
        assert.throws(() => window2.document.evaluate("//[", window2.document), { code: 51 });

        const result1 = window1.document.evaluate("1", window1.document, null, window1.XPathResult.NUMBER_TYPE);
        assert.throws(() => result1.stringValue, { code: 98 });
        const result2 = window2.document.evaluate("1", window2.document, null, window2.XPathResult.NUMBER_TYPE);
        assert.throws(() => result2.stringValue, { code: 52 });
      });
    });
  }
});
