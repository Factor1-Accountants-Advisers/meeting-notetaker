import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import './assets/index.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

async function render(): Promise<void> {
  const Root =
    import.meta.env.DEV && import.meta.env.MODE === 'ui-preview'
      ? (await import('./PreviewApp')).PreviewApp
      : App

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  )
}

void render()
