import { startSetupServer } from "../dist/config/setup-server.js";

const setup = await startSetupServer();
console.log(setup.url);
