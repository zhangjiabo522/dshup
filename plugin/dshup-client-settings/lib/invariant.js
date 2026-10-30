const PACKAGE_NAME = "dshup-client-settings";
const name = "dshup-client-settings-invariant";
const inject = ["invariants"];
const install = () => {};
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
export { apply, inject, name };
