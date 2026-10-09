"use strict";
const CSSStyleProperties = require("../../../generated/idl/CSSStyleProperties.js");

// The inline style declaration block is created lazily, on first access, from the current `style` attribute. Until
// then, `style` attribute changes need no parsing (see `_styleAttributeChanged()`).
class ElementCSSInlineStyle {
  _initElementCSSInlineStyle() {
    this._settingCssText = false;
    this._inlineStyle = null;
  }

  get style() {
    if (this._inlineStyle === null) {
      const style = CSSStyleProperties.createImpl(this._globalObject, [], {
        ownerNode: this
      });
      this._inlineStyle = style;
      const value = this.getAttributeNS(null, "style");
      if (value !== null) {
        const wasSettingCssText = this._settingCssText;
        this._settingCssText = true;
        style.cssText = value;
        this._settingCssText = wasSettingCssText;
      }
    }
    return this._inlineStyle;
  }

  // Called from the attribute change steps when the `style` attribute changed and the change did not originate from
  // the declaration block itself.
  _styleAttributeChanged(value) {
    if (this._inlineStyle === null) {
      return;
    }
    this._settingCssText = true;
    this._inlineStyle.cssText = value;
    this._settingCssText = false;
  }
}

module.exports = {
  implementation: ElementCSSInlineStyle
};
