import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response, Router } from "express";
import { BrowserClient } from "./browser-client";

const TOOL_DEFINITIONS = [
  {
    name: "navigate",
    description: "Navigate the browser to a URL",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"], description: "When to consider navigation complete (default: load)" },
      },
      required: ["url"],
    },
  },
  {
    name: "click",
    description: "Click on an element matching a CSS/text selector",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector or text selector (e.g. 'text=Submit')" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default: left)" },
        clickCount: { type: "number", description: "Number of clicks (default: 1)" },
      },
      required: ["selector"],
    },
  },
  {
    name: "type",
    description: "Type text into an input element",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector for the input element" },
        text: { type: "string", description: "Text to type" },
        delay: { type: "number", description: "Delay between keystrokes in ms (for key-by-key typing)" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "screenshot",
    description: "Take a screenshot of the current page. Returns an image for visual analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector to screenshot a specific element" },
        fullPage: { type: "boolean", description: "Capture the full scrollable page (default: false)" },
      },
    },
  },
  {
    name: "evaluate",
    description: "Execute JavaScript in the browser page context and return the result",
    inputSchema: {
      type: "object" as const,
      properties: {
        script: { type: "string", description: "JavaScript code to evaluate" },
      },
      required: ["script"],
    },
  },
  {
    name: "get_text",
    description: "Get the text content of an element",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector for the element" },
      },
      required: ["selector"],
    },
  },
  {
    name: "get_page_content",
    description: "Get the full HTML content of the current page",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "wait_for",
    description: "Wait for an element to reach a specific state",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector to wait for" },
        state: { type: "string", enum: ["attached", "detached", "visible", "hidden"], description: "Target state (default: visible)" },
        timeout: { type: "number", description: "Max wait time in ms (default: 30000)" },
      },
      required: ["selector"],
    },
  },
  {
    name: "go_back",
    description: "Navigate back in browser history",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "go_forward",
    description: "Navigate forward in browser history",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "set_viewport",
    description: "Set the browser viewport size",
    inputSchema: {
      type: "object" as const,
      properties: {
        width: { type: "number", description: "Viewport width in pixels" },
        height: { type: "number", description: "Viewport height in pixels" },
      },
      required: ["width", "height"],
    },
  },
  {
    name: "get_console_logs",
    description: "Get buffered browser console log entries",
    inputSchema: {
      type: "object" as const,
      properties: {
        clear: { type: "boolean", description: "Clear the log buffer after reading (default: false)" },
      },
    },
  },
  {
    name: "pdf",
    description: "Generate a PDF of the current page (Chromium only)",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_cookies",
    description: "Get browser cookies, optionally filtered by URLs",
    inputSchema: {
      type: "object" as const,
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "Filter cookies by these URLs" },
      },
    },
  },
  {
    name: "set_cookies",
    description: "Set browser cookies",
    inputSchema: {
      type: "object" as const,
      properties: {
        cookies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "string" },
              url: { type: "string" },
              domain: { type: "string" },
              path: { type: "string" },
              expires: { type: "number" },
              httpOnly: { type: "boolean" },
              secure: { type: "boolean" },
              sameSite: { type: "string", enum: ["Strict", "Lax", "None"] },
            },
            required: ["name", "value"],
          },
          description: "Array of cookie objects to set",
        },
      },
      required: ["cookies"],
    },
  },
  {
    name: "clear_cookies",
    description: "Clear all browser cookies",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

export class MCPServer {
  private browserClient: BrowserClient;

  constructor(browserClient: BrowserClient) {
    this.browserClient = browserClient;
  }

  private createServer(): Server {
    const server = new Server(
      { name: "browser-mcp", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers(server);
    return server;
  }

  private setupHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: TOOL_DEFINITIONS };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const result = await this.handleToolCall(name, args ?? {});
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    });
  }

  private async handleToolCall(name: string, args: Record<string, unknown>) {
    switch (name) {
      case "navigate": {
        const result = await this.browserClient.navigate(
          args.url as string,
          args.waitUntil as "load" | "domcontentloaded" | "networkidle" | undefined
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      case "click": {
        const result = await this.browserClient.click(args.selector as string, {
          button: args.button as "left" | "right" | "middle" | undefined,
          clickCount: args.clickCount as number | undefined,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      case "type": {
        const result = await this.browserClient.type(
          args.selector as string,
          args.text as string,
          args.delay as number | undefined
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      case "screenshot": {
        const base64 = await this.browserClient.screenshot(
          args.selector as string | undefined,
          args.fullPage as boolean | undefined
        );
        return {
          content: [{ type: "image" as const, data: base64, mimeType: "image/png" }],
        };
      }

      case "evaluate": {
        const result = await this.browserClient.evaluate(args.script as string);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      case "get_text": {
        const result = await this.browserClient.getText(args.selector as string);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      case "get_page_content": {
        const html = await this.browserClient.getPageContent();
        return { content: [{ type: "text" as const, text: html }] };
      }

      case "wait_for": {
        const result = await this.browserClient.waitFor(args.selector as string, {
          state: args.state as "attached" | "detached" | "visible" | "hidden" | undefined,
          timeout: args.timeout as number | undefined,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      case "go_back": {
        const result = await this.browserClient.goBack();
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      case "go_forward": {
        const result = await this.browserClient.goForward();
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      case "set_viewport": {
        const result = await this.browserClient.setViewport(
          args.width as number,
          args.height as number
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      case "get_console_logs": {
        const logs = this.browserClient.getConsoleLogs(args.clear as boolean | undefined);
        return { content: [{ type: "text" as const, text: JSON.stringify(logs) }] };
      }

      case "pdf": {
        const base64 = await this.browserClient.pdf();
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ pdf: base64 }) }],
        };
      }

      case "get_cookies": {
        const cookies = await this.browserClient.getCookies(args.urls as string[] | undefined);
        return { content: [{ type: "text" as const, text: JSON.stringify(cookies) }] };
      }

      case "set_cookies": {
        const result = await this.browserClient.setCookies(args.cookies as Array<{
          name: string; value: string; url?: string; domain?: string; path?: string;
          expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None";
        }>);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      case "clear_cookies": {
        const result = await this.browserClient.clearCookies();
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  getToolDefinitions() {
    return TOOL_DEFINITIONS;
  }

  createRouter(): Router {
    const router = Router();

    router.post("/", express.json(), async (req: Request, res: Response) => {
      console.log("MCP HTTP POST request received");
      const server = this.createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });
      res.on("close", () => {
        server.close().catch(console.error);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    return router;
  }

  async stop(): Promise<void> {
    console.log("MCP Server stopped");
  }
}
