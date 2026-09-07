import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createCodeloreServer } from "./create-server.js";

export async function startStdioServer(options: { rootDir: string }): Promise<void> {
  const server = await createCodeloreServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
