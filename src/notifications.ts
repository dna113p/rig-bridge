import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface DesktopNotification { title: string; body: string; url: string }
const exec = promisify(execFile);

/** No shell interpolation. Errors remain visible in the persisted inbox. */
export async function notifyDesktop(notification: DesktopNotification): Promise<void> {
  if (process.platform !== "linux") throw new Error("Desktop alerts currently require Linux");
  try {
    const { stdout: capabilities } = await exec("busctl", ["--user", "--", "call", "org.freedesktop.Notifications",
      "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "GetCapabilities"], { timeout: 5000, maxBuffer: 4096 });
    const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    const markup = capabilities.includes('"body-markup"');
    const body = markup ? escape(notification.body) : notification.body;
    const link = markup && capabilities.includes('"body-hyperlinks"') ? `<a href="${escape(notification.url)}">Open thread</a>` : notification.url;
    // busctl is commonly available on systemd desktops, including the supported Linux host.
    await exec("busctl", ["--user", "--", "call", "org.freedesktop.Notifications", "/org/freedesktop/Notifications",
      "org.freedesktop.Notifications", "Notify", "susssasa{sv}i",
      "Rig Bridge", "0", "dialog-information", notification.title, `${body}\n${link}`,
      "0", "0", "-1"], { timeout: 5000, maxBuffer: 4096 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        // Escape user text because notify-send bodies may be interpreted as markup.
        const body = `${notification.body}\n${notification.url}`.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        await exec("notify-send", ["--app-name=Rig Bridge", "--icon=dialog-information", "--", notification.title, body], { timeout: 5000, maxBuffer: 4096 });
        return;
      } catch { throw new Error("Install busctl or notify-send and run the bridge in your desktop session to enable desktop alerts"); }
    }
    throw new Error("Desktop notification delivery failed; check the desktop notification service and user session bus");
  }
}
