/**
 * Browser-based login flow for MCP authentication.
 *
 * 1. Starts a temporary local HTTP server
 * 2. Opens the user's browser to the Aphorist login page with a callback URL
 * 3. Captures the auth token from the redirect
 */

import http from "node:http";
import open from "open";

export interface BrowserLoginResult {
  token: string;
}

export async function browserLogin(
  webUrl: string,
  timeoutMs = 120_000,
): Promise<BrowserLoginResult> {
  return new Promise<BrowserLoginResult>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);

      if (url.pathname === "/callback") {
        const token = url.searchParams.get("token");

        if (token) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <!DOCTYPE html>
            <html>
              <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f8fafc;">
                <div style="text-align: center;">
                  <h1 style="color: #16a34a;">Authenticated!</h1>
                  <p style="color: #64748b;">You can close this window and return to your MCP client.</p>
                </div>
              </body>
            </html>
          `);
          cleanup();
          resolve({ token });
        } else {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
            <!DOCTYPE html>
            <html>
              <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f8fafc;">
                <div style="text-align: center;">
                  <h1 style="color: #dc2626;">Authentication failed</h1>
                  <p style="color: #64748b;">No token received. Please try again.</p>
                </div>
              </body>
            </html>
          `);
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Browser login timed out. Please try again."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      server.close();
    }

    // Listen on a random port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        cleanup();
        reject(new Error("Failed to start callback server"));
        return;
      }

      const callbackUrl = `http://localhost:${addr.port}/callback`;
      const loginUrl = `${webUrl}/auth/verify?mcp_callback=${encodeURIComponent(callbackUrl)}`;

      // Open the browser
      open(loginUrl).catch(() => {
        // If open fails, user can manually navigate
      });

      // Log to stderr so it shows in MCP client logs (stdout is the MCP transport)
      process.stderr.write(
        `\nOpening browser for login: ${loginUrl}\n` +
          `If the browser didn't open, visit the URL above manually.\n\n`,
      );
    });

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}
