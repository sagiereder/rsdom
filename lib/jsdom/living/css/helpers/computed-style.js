"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Specificity = require("@bramus/specificity").default;
const CSSImportRule = require("../../../../generated/idl/CSSImportRule.js");
const CSSMediaRule = require("../../../../generated/idl/CSSMediaRule.js");
const CSSStyleProperties = require("../../../../generated/idl/CSSStyleProperties.js");
const CSSStyleRule = require("../../../../generated/idl/CSSStyleRule.js");
const { asciiLowercase } = require("../../helpers/strings.js");
const { evaluateMediaList } = require("../MediaList-impl.js");
const { parseStyleSheet } = require("./css-parser.js");
const { isGlobalKeyword } = require("./css-values.js");
const { absoluteFontSize } = require("./font-sizes.js");
const { systemColors } = require("./system-colors.js");
const styleIndex = require("./style-index.js");

const useStyleIndex = process.env.JSDOM_CSS_INDEX !== "0";
const verifyStyleIndex = process.env.JSDOM_CSS_VERIFY === "1";

const defaultStyleSheet = fs.readFileSync(
  path.resolve(__dirname, "../../../browser/default-stylesheet.css"),
  { encoding: "utf-8" }
);
let parsedDefaultStyleSheet;

function getComputedStyleDeclaration(elementImpl) {
  const styleCache = elementImpl._ownerDocument._styleCache;
  const cachedDeclaration = styleCache.get(elementImpl);
  if (cachedDeclaration) {
    const clonedDeclaration = CSSStyleProperties.createImpl(elementImpl._globalObject, [], {
      computed: true,
      ownerNode: elementImpl
    });

    clonedDeclaration._copyDeclarationsFrom(cachedDeclaration);
    clonedDeclaration._readonly = true;

    return clonedDeclaration;
  }

  const declaration = prepareComputedStyleDeclaration(elementImpl, styleCache);
  declaration._readonly = true;

  return declaration;
}

function prepareComputedStyleDeclaration(elementImpl, styleCache) {
  const { style } = elementImpl;
  const declaration = CSSStyleProperties.createImpl(elementImpl._globalObject, [], {
    computed: true,
    ownerNode: elementImpl
  });

  // Cache the declaration before processing.
  styleCache.set(elementImpl, declaration);

  if (applyStyleSheetRules(elementImpl, declaration)) {
    return declaration;
  }

  // Not every element implements `ElementCSSInlineStyle`.
  if (style) {
    for (let i = 0; i < style.length; i++) {
      handlePropertyForInlineStyle(style.item(i), declaration, style);
    }
  }

  return declaration;
}

function applyStyleSheetRules(elementImpl, declaration) {
  if (!parsedDefaultStyleSheet) {
    // The parsed default stylesheet will be composed of CSSOM objects from the first global object accessed. This is a
    // bit strange, but since we only ever access the internals of `parsedDefaultStyleSheet`, and don't expose it to
    // callers, it shouldn't cause any issues.
    parsedDefaultStyleSheet = parseStyleSheet(defaultStyleSheet, elementImpl._globalObject);
  }

  const document = elementImpl._ownerDocument;
  if (
    useStyleIndex &&
    document.contentType === "text/html" &&
    styleIndex.isFastPathElement(elementImpl) &&
    styleIndex.isDocumentRooted(elementImpl, document)
  ) {
    applyIndexedStyleSheetRules(elementImpl, declaration);
    return true;
  }

  const specificities = new Map();
  handleSheet(parsedDefaultStyleSheet, elementImpl, declaration, specificities);
  for (const sheetImpl of document.styleSheets._list) {
    handleSheet(sheetImpl, elementImpl, declaration, specificities);
  }
  return false;
}

const CASCADE_CACHE_LIMIT = 4096;

// Equivalent to the handleSheet() loop above followed by applying the inline style, but only visits the rules that can
// match the element (see style-index.js), and matches most selectors with compiled matchers instead of dom-selector.
//
// Applying declarations to a computed declaration only depends on the sequence of (rule, specificity) pairs and the
// inline style, not on the element. So the result is cached per distinct match list, which elements sharing the same
// selectors (the common case) then reuse instead of re-parsing every declaration value.
function applyIndexedStyleSheetRules(elementImpl, declaration) {
  const document = elementImpl._ownerDocument;
  const sheets = [parsedDefaultStyleSheet, ...document.styleSheets._list];
  const index = styleIndex.getStyleIndex(document, sheets);
  const ctx = { classSets: new Map() };
  const mediaResults = new Map();
  const matched = [];
  let key = "";

  for (const entry of index.candidates(elementImpl, ctx)) {
    let mediaMatches = true;
    for (const mediaList of entry.media) {
      let result = mediaResults.get(mediaList);
      if (result === undefined) {
        result = evaluateMediaList(mediaList);
        mediaResults.set(mediaList, result);
      }
      if (!result) {
        mediaMatches = false;
        break;
      }
    }
    if (!mediaMatches) {
      continue;
    }
    let specificity = null;
    if (index.quirks && entry.usesIdOrClass) {
      // Quirks mode id/class matching isn't modeled by the compiled matchers.
      specificity = matchRuleSpecificity(entry.rule, elementImpl);
    } else if (entry.kind === styleIndex.FAST) {
      if (styleIndex.matchAnyComplex(entry.complexes, elementImpl, ctx)) {
        specificity = styleIndex.getSpecificity(entry);
      }
    } else if (entry.kind === styleIndex.PREFILTER) {
      if (styleIndex.matchAnyComplex(entry.complexes, elementImpl, ctx)) {
        specificity = matchRuleSpecificity(entry.rule, elementImpl);
      }
    } else {
      specificity = matchRuleSpecificity(entry.rule, elementImpl);
    }
    if (specificity !== null) {
      matched.push([entry.rule, specificity]);
      key += `${entry.order},`;
    }
  }

  if (verifyStyleIndex) {
    verifyIndexedMatches(elementImpl, sheets, matched);
  }

  // Not every element implements `ElementCSSInlineStyle`.
  const { style } = elementImpl;
  if (style && style.length > 0) {
    key += "|";
    for (let i = 0; i < style.length; i++) {
      const property = style.item(i);
      key += `${property}\u0000${style.getPropertyValue(property)}\u0000${style.getPropertyPriority(property)}\u0001`;
    }
  }

  const cached = index.cascadeCache.get(key);
  if (cached !== undefined) {
    declaration._restoreDeclarations(cached);
    return;
  }

  const specificities = new Map();
  for (const [ruleImpl, specificity] of matched) {
    handleStyle(ruleImpl.style, declaration, specificities, specificity);
  }
  if (style) {
    for (let i = 0; i < style.length; i++) {
      handlePropertyForInlineStyle(style.item(i), declaration, style);
    }
  }

  if (index.cascadeCache.size >= CASCADE_CACHE_LIMIT) {
    index.cascadeCache.clear();
  }
  index.cascadeCache.set(key, declaration._snapshotDeclarations());
}

function matchRuleSpecificity(ruleImpl, elementImpl) {
  if (ruleMightMatchElement(ruleImpl, elementImpl)) {
    const { ast, match } = matches(ruleImpl.selectorText, elementImpl);
    if (match) {
      return Specificity.max(...Specificity.calculate(ast)).value;
    }
  }
  return null;
}

// Debugging aid (JSDOM_CSS_VERIFY=1): checks the indexed cascade against the exhaustive one.
function verifyIndexedMatches(elementImpl, sheets, verified) {
  const expected = [];
  const collect = (ruleImpl, specificity) => expected.push([ruleImpl, specificity]);
  const walk = sheetImpl => {
    for (const ruleImpl of sheetImpl.cssRules._list) {
      if (CSSImportRule.isImpl(ruleImpl)) {
        if (ruleImpl.styleSheet !== null && evaluateMediaList(ruleImpl.media._list)) {
          walk(ruleImpl.styleSheet);
        }
      } else if (CSSMediaRule.isImpl(ruleImpl)) {
        if (evaluateMediaList(ruleImpl.media._list)) {
          for (const innerRule of ruleImpl.cssRules._list) {
            matchRule(innerRule, elementImpl, collect);
          }
        }
      } else if (CSSStyleRule.isImpl(ruleImpl)) {
        matchRule(ruleImpl, elementImpl, collect);
      }
    }
  };
  for (const sheetImpl of sheets) {
    walk(sheetImpl);
  }
  const describe = list => list.map(([r, sp]) => `${r.selectorText} (${JSON.stringify(sp)})`).join(" | ");
  const ok = expected.length === verified.length && expected.every(([r, sp], i) => {
    return verified[i][0] === r && Specificity.compare(sp, verified[i][1]) === 0;
  });
  if (!ok) {
    throw new Error(`style index mismatch for <${elementImpl.localName}> ${elementImpl.outerHTML.slice(0, 200)}\n` +
      `expected: ${describe(expected)}\nactual:   ${describe(verified)}`);
  }
}

function matchRule(ruleImpl, elementImpl, callback) {
  if (ruleMightMatchElement(ruleImpl, elementImpl)) {
    const { ast, match } = matches(ruleImpl.selectorText, elementImpl);
    if (match) {
      callback(ruleImpl, Specificity.max(...Specificity.calculate(ast)).value);
    }
  }
}

function handleSheet(sheetImpl, elementImpl, declaration, specificities) {
  for (const ruleImpl of sheetImpl.cssRules._list) {
    if (CSSImportRule.isImpl(ruleImpl)) {
      if (ruleImpl.styleSheet !== null && evaluateMediaList(ruleImpl.media._list)) {
        handleSheet(ruleImpl.styleSheet, elementImpl, declaration, specificities);
      }
    } else if (CSSMediaRule.isImpl(ruleImpl)) {
      if (evaluateMediaList(ruleImpl.media._list)) {
        for (const innerRule of ruleImpl.cssRules._list) {
          handleRule(innerRule, elementImpl, declaration, specificities);
        }
      }
    } else if (CSSStyleRule.isImpl(ruleImpl)) {
      handleRule(ruleImpl, elementImpl, declaration, specificities);
    }
  }
}

function handleRule(ruleImpl, elementImpl, declaration, specificities) {
  if (ruleMightMatchElement(ruleImpl, elementImpl)) {
    const { ast, match } = matches(ruleImpl.selectorText, elementImpl);
    if (match) {
      // The specificity only depends on the selector AST, not on any individual property, so it is computed once per
      // rule rather than once per property. This is a significant win for rules with many declarations.
      const { value: specificity } = Specificity.max(...Specificity.calculate(ast));
      handleStyle(ruleImpl.style, declaration, specificities, specificity);
    }
  }
}

function handleStyle(style, declaration, specificities, specificity) {
  for (let i = 0; i < style.length; i++) {
    const property = style.item(i);
    handleProperty(property, declaration, style, specificities, specificity);
  }
}

function handleProperty(property, declaration, style, specificities, specificity) {
  const value = style.getPropertyValue(property);
  const priority = style.getPropertyPriority(property);
  if (priority) {
    declaration.setProperty(property, value, priority);
  } else if (!declaration.getPropertyPriority(property)) {
    if (specificities.has(property)) {
      if (Specificity.compare(specificity, specificities.get(property)) >= 0) {
        specificities.set(property, specificity);
        declaration.setProperty(property, value);
      }
    } else {
      specificities.set(property, specificity);
      declaration.setProperty(property, value);
    }
  }
}

function handlePropertyForInlineStyle(property, declaration, style) {
  const value = style.getPropertyValue(property);
  const priority = style.getPropertyPriority(property);
  if (!declaration.getPropertyPriority(property) || priority) {
    declaration.setProperty(property, value, priority);
  }
}

function ruleMightMatchElement(ruleImpl, elementImpl) {
  if (!ruleImpl._selectorSubjects) {
    const domSelector = elementImpl._ownerDocument._getDOMSelector();
    ruleImpl._selectorSubjects =
      domSelector.extractSubjects(
        ruleImpl.selectorText,
        elementImpl._ownerDocument.contentType !== "text/html"
      );
  }

  const subjects = ruleImpl._selectorSubjects;
  if (subjects.length === 0) {
    return true;
  }

  const id = elementImpl.getAttributeNS(null, "id");
  const { classList } = elementImpl;
  // TODO: Remove toLowerCase() after updating the dom-selector.
  const tag = elementImpl._localName.toLowerCase();
  for (const keys of subjects) {
    let mightMatch = true;
    if (keys.id && keys.id !== id) {
      mightMatch = false;
    } else if (keys.className && !classList.contains(keys.className)) {
      mightMatch = false;
      // TODO: Remove toLowerCase() after updating the dom-selector.
    } else if (keys.tag && keys.tag.toLowerCase() !== tag) {
      mightMatch = false;
    }

    if (mightMatch) {
      return true;
    }
  }

  return false;
}

function matches(selectorText, elementImpl) {
  const domSelector = elementImpl._ownerDocument._getDOMSelector();
  const { ast, match, pseudoElement } = domSelector.check(selectorText, elementImpl);
  // `pseudoElement` is a pseudo-element selector (e.g. `::before`).
  // However, we do not support getComputedStyle(element, pseudoElement), so `match` is set to `false`.
  if (pseudoElement) {
    return {
      match: false
    };
  }
  return { ast, match, pseudoElement };
}

function replaceEmptyValueAndKeywords(
  property,
  value,
  elementImpl,
  { inherit, initial, isColor, longhands }
) {
  if (value === "") {
    if (longhands) {
      return "";
    } else if (!inherit || !elementImpl.parentElement) {
      return initial;
    }
    value = getInheritedPropertyValue(property, elementImpl, { inherit, initial, isColor });
  }

  if (isGlobalKeyword(value)) {
    value = replaceGlobalKeywords(property, value, elementImpl, { inherit, initial, isColor });
  }

  return value;
}

function getInheritedPropertyValue(property, elementImpl, { inherit, initial, isColor }) {
  const styleCache = elementImpl._ownerDocument._styleCache;

  let parent = elementImpl.parentElement;
  while (parent) {
    let declaration, value;
    if (styleCache.has(parent)) {
      declaration = styleCache.get(parent);
    } else {
      declaration = prepareComputedStyleDeclaration(parent, styleCache);
    }
    if (isColor) {
      // For color-related properties, unset the _computed flag to retrieve the specified value.
      // @asamuzakjp/css-color handles the resolution of the specified value.
      declaration._computed = false;
      value = declaration.getPropertyValue(property);
      // Restore the _computed flag.
      declaration._computed = true;
      // If the value is a system color value, retrieve it again as a computed value.
      if (value && systemColors.has(asciiLowercase(value))) {
        value = declaration.getPropertyValue(property);
      }
    } else {
      // Inheritance transfers the computed value, not the resolved value getPropertyValue() returns.
      // The parent's computed value already accounts for inheritance, even when it is empty.
      return declaration._getComputedPropertyValue(property);
    }
    if (value) {
      if (isColor && isGlobalKeyword(value)) {
        return replaceGlobalKeywords(property, value, parent, { inherit, initial, isColor });
      }
      return value;
    } else if (!parent.parentElement || !inherit) {
      break;
    }
    parent = parent.parentElement;
  }

  return initial;
}

function replaceGlobalKeywords(property, value, elementImpl, { inherit, initial, isColor }) {
  let element = elementImpl;
  while (element) {
    switch (value) {
      case "initial": {
        return initial;
      }
      case "inherit": {
        if (!element.parentElement) {
          return initial;
        }
        value = getInheritedPropertyValue(property, element, { inherit, initial, isColor });
        break;
      }
      case "unset": {
        if (!inherit || !element.parentElement) {
          return initial;
        }
        value = getInheritedPropertyValue(property, element, { inherit, initial, isColor });
        break;
      }
      case "revert-layer": {
        // TODO: https://drafts.csswg.org/css-cascade-5/#revert-layer
        return value;
      }
      case "revert": {
        // TODO: https://drafts.csswg.org/css-cascade-5/#default
        return value;
      }
      default: {
        // fall through; value is not a CSS-wide keyword.
      }
    }
    if (element.parentElement) {
      if (!value) {
        element = element.parentElement;
      } else if (isGlobalKeyword(value)) {
        return replaceGlobalKeywords(property, value, element, { inherit, initial, isColor });
      } else {
        return value;
      }
    } else {
      return initial;
    }
  }

  return value;
}

function getParentFontSizeInPixels(elementImpl) {
  const styleCache = elementImpl._ownerDocument._styleCache;
  const parent = elementImpl.parentElement;
  let declaration;
  if (styleCache.has(parent)) {
    declaration = styleCache.get(parent);
  } else {
    declaration = prepareComputedStyleDeclaration(parent, styleCache);
  }

  const fontSize = declaration.getPropertyValue("font-size");
  if (absoluteFontSize.has(fontSize)) {
    return absoluteFontSize.get(fontSize).px;
  }

  const parsed = parseFloat(fontSize);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  // Fallback to initial font-size (medium)
  return absoluteFontSize.get("medium").px;
}

exports.SHADOW_DOM_PSEUDO_REGEXP = /^::(?:part|slotted)\(/i;
exports.getComputedStyleDeclaration = getComputedStyleDeclaration;
exports.getInheritedPropertyValue = getInheritedPropertyValue;
exports.getParentFontSizeInPixels = getParentFontSizeInPixels;
exports.replaceEmptyValueAndKeywords = replaceEmptyValueAndKeywords;
