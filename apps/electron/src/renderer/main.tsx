/** Electron renderer 的轻量分流入口。 */
import '@fontsource-variable/inter/index.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/globals.css'

/** 路径窗口必须在加载任何普通业务模块前完成识别。 */
const isDataRootManagementWindow = new URLSearchParams(window.location.search)
  .get('window') === 'data-root-migration'

if (isDataRootManagementWindow) {
  import('./components/path-management/DataRootMigrationApp').then(({ DataRootMigrationApp }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <DataRootMigrationApp />
      </React.StrictMode>,
    )
  })
} else {
  void import('./normal-renderer-main')
}
