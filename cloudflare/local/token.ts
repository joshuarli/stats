import { accessToken } from "../test/access-token.ts";

process.stdout.write(`${await accessToken()}\n`);
