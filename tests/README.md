# rsdom tests

rsdom runs jsdom's test suite unchanged, using two frameworks:

* [**web-platform-tests**](https://web-platform-tests.org/): `.html` files that run inside a jsdom window. The upstream WPT checkout is a git submodule at [`web-platform-tests/tests`](./web-platform-tests/). [`to-run.yaml`](./web-platform-tests/to-run.yaml) selects which tests run and records the expected failures. Tests that jsdom wrote itself live in [`web-platform-tests/to-upstream`](./web-platform-tests/to-upstream/).
* **[Mocha](https://mochajs.org/) tests**: the jsdom API tests in [`api`](./api/), plus legacy tests in [`to-port-to-wpts`](./to-port-to-wpts/).

The quickest way to run them is the sharded runner:

```sh
node scripts/dev/test.js            # tests relevant to your changes
node scripts/dev/test.js --all      # everything
JSDOM_NATIVE=0 node scripts/dev/test.js --all   # pure-JS fallback
```

The npm scripts (`npm run test:api`, `test:wpt`, `test:tuwpt`, `test:to-port-to-wpts`) also work and accept `--fgrep` and `--reporter min`.

See [Contributing.md](../Contributing.md) for the overall workflow.
