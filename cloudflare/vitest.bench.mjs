import base from "./vitest.config.mjs";

export default { ...base, test: { ...base.test, include: ["bench/**/*.workerd.ts"], exclude: [] } };
