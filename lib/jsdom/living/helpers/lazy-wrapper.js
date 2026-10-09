"use strict";
const idlUtils = require("../../../generated/idl/utils");

const { wrapperSymbol, ctorRegistrySymbol } = idlUtils;

function defineWrapper(impl, wrapper) {
  Object.defineProperty(impl, wrapperSymbol, { value: wrapper, writable: true, enumerable: true, configurable: true });
}

// Lets impls of exactly `ImplClass` be created without a wrapper, which is then made on first access through
// `wrapperForImpl()`. Many internally created nodes (attributes, text from `textContent` or the parser) are never
// exposed to script, so this saves allocating and branding their wrappers. `getGenerated` returns the generated
// interface module for `interfaceName`; it is a function to avoid a require cycle.
//
// Create such impls with `new ImplClass(globalObject, [], privateData)`, never for a subclass of `ImplClass`, whose
// wrapper would get the wrong interface. Impls created through the generated `create()`/`setup()` path store their
// wrapper through the setter, as before.
exports.installLazyWrapper = (ImplClass, getGenerated, interfaceName) => {
  let generated = null;
  Object.defineProperty(ImplClass.prototype, wrapperSymbol, {
    get() {
      generated ??= getGenerated();
      const globalObject = this._globalObject;
      const wrapper = Object.create(globalObject[ctorRegistrySymbol][interfaceName].prototype);
      generated._internalSetup(wrapper, globalObject);
      idlUtils.registerWrapper(wrapper, this, generated.interfaceDescriptor);
      defineWrapper(this, wrapper);
      return wrapper;
    },
    set(wrapper) {
      defineWrapper(this, wrapper);
    },
    enumerable: false,
    configurable: true
  });
};

