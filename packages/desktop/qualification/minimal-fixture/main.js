import { app, BrowserWindow } from "electron"
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600 })
  win.loadURL("data:text/html,<h1>Hello Playwright</h1>")
})
