import domenicConfig from "@domenic/eslint-config";
import domenicStylistic from "@domenic/eslint-config/stylistic";
import globals from "globals";
import html from "eslint-plugin-html";
import jsdomInternal from "./scripts/eslint-plugin/index.mjs";
import n from "eslint-plugin-n";

const restrictedRequires = [
  {
    name: "@exodus/bytes/utf8.js",
    message: "Use src/jsdom/living/helpers/encoding.js instead."
  },
  {
    name: "css-tree",
    message: "Use src/jsdom/living/css/helpers/patched-csstree.js instead."
  },
  {
    name: "@csstools/css-syntax-patches-for-csstree",
    message: "Use src/jsdom/living/css/helpers/patched-csstree.js instead."
  }
];

export default [
  {
    ignores: [
      "bench/**",
      ".devshim/**",
      "src/jsdom/level3/xpath.js",
      "src/generated/**",
      "tests/api/fixtures/**",
      "tests/to-port-to-wpts/jquery-fixtures/**",
      "tests/to-port-to-wpts/files/**",
      "tests/to-port-to-wpts/frame.js",
      "tests/to-port-to-wpts/level1/**",
      "tests/to-port-to-wpts/level2/**",
      "tests/to-port-to-wpts/level3/**",
      "tests/to-port-to-wpts/script.js",
      "tests/web-platform-tests/tests/**",
      "tests/web-platform-tests/to-upstream/**/*dont-upstream*"
    ]
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node
    }
  },
  ...domenicConfig,
  ...domenicStylistic,
  {
    plugins: {
      "jsdom-internal": jsdomInternal
    },
    rules: {
      // Overrides for jsdom
      "@stylistic/array-element-newline": "off",
      "no-await-in-loop": "off",
      "no-implied-eval": "off",
      "no-invalid-this": "off",
      "require-unicode-regexp": "off",
      "prefer-template": "off",
      "new-cap": ["error", { capIsNewExceptions: ["ByteString", "USVString", "DOMString"] }],

      // Custom rules
      // Only hooks with shared base implementations require `super`.
      "jsdom-internal/hook-super-invocation": [
        "error",
        { ancestor: "NodeImpl", hook: "_childrenChangedSteps" },
        { ancestor: "NodeImpl", hook: "_childrenInsertedSteps" },
        { ancestor: "NodeImpl", hook: "_removingSteps" },
        { ancestor: "ElementImpl", hook: "_adoptingSteps" },
        { ancestor: "ElementImpl", hook: "_attributeChangeSteps" }
      ]
    }
  },
  {
    files: ["src/**"],
    plugins: { n },
    rules: {
      "n/no-restricted-require": ["error", restrictedRequires],
      "no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message: "Use Uint8Array instead."
        }
      ],
      "no-restricted-properties": [
        "error",
        {
          property: "getAttribute",
          message: "Use 'getAttributeNS' with null as the namespace to access attributes within jsdom"
        },
        {
          property: "setAttribute",
          message: "Use 'setAttributeNS' with null as the namespace to access attributes within jsdom"
        },
        {
          property: "hasAttribute",
          message: "Use 'hasAttributeNS' with null as the namespace to access attributes within jsdom"
        },
        {
          property: "removeAttribute",
          message: "Use 'removeAttributeNS' with null as the namespace to access attributes within jsdom"
        },
        {
          property: "toggleAttribute",
          message: "Use 'setAttributeNS' and 'removeAttributeNS' with null as the namespace to access attributes " +
                   "within jsdom"
        }
      ]
    }
  },
  {
    files: ["src/jsdom/living/css/helpers/patched-csstree.js"],
    rules: {
      "n/no-restricted-require": ["error", restrictedRequires.filter(r => !r.name.includes("css"))]
    }
  },
  {
    files: ["tests/api/**"],
    rules: {
      "no-loop-func": "off"
    }
  },
  {
    files: ["tests/web-platform-tests/to-upstream/**/*.{js,mjs,html}"],
    plugins: { html },
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,

        /* eslint-disable camelcase */
        EventWatcher: "readonly",
        test: "readonly",
        async_test: "readonly",
        promise_test: "readonly",
        promise_rejects: "readonly",
        promise_rejects_dom: "readonly",
        generate_tests: "readonly",
        setup: "readonly",
        done: "readonly",
        on_event: "readonly",
        step_timeout: "readonly",
        format_value: "readonly",
        assert_true: "readonly",
        assert_false: "readonly",
        assert_equals: "readonly",
        assert_not_equals: "readonly",
        assert_in_array: "readonly",
        assert_object_equals: "readonly",
        assert_array_equals: "readonly",
        assert_approx_equals: "readonly",
        assert_less_than: "readonly",
        assert_greater_than: "readonly",
        assert_between_exclusive: "readonly",
        assert_less_than_equal: "readonly",
        assert_greater_than_equal: "readonly",
        assert_between_inclusive: "readonly",
        assert_regexp_match: "readonly",
        assert_class_string: "readonly",
        assert_exists: "readonly",
        assert_own_property: "readonly",
        assert_not_exists: "readonly",
        assert_inherits: "readonly",
        assert_idl_attribute: "readonly",
        assert_readonly: "readonly",
        assert_throws_dom: "readonly",
        assert_throws_js: "readonly",
        assert_unreached: "readonly",
        assert_any: "readonly",
        fetch_tests_from_worker: "readonly",
        timeout: "readonly",
        add_start_callback: "readonly",
        add_test_state_callback: "readonly",
        add_result_callback: "readonly",
        add_completion_callback: "readonly"
        /* eslint-enable camelcase */
      }
    },
    rules: {
      "@stylistic/padded-blocks": "off", // we like to add spaces around the main test block
      "camelcase": "off", // setting options like allow_uncaught_exception requires this
      "no-implicit-globals": "off", // it doesn't much matter if we use top-level function declarations here
      "new-cap": [
        "error", {
        // window.external
          capIsNewExceptions: ["AddSearchProvider", "IsSearchProviderInstalled"]
        }
      ]
    }
  }
];
