const { contextBridge, ipcRenderer } = require('electron')

/** 向隔离 renderer 暴露 BrowserSlot 唯一需要的布局上报接口。 */
const electronAPI = {
  setAgentBrowserLayout(layout) {
    return ipcRenderer.invoke('browser-modal-smoke:set-layout', layout)
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
