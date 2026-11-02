import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router"
import "./index.css"
import { coreRoutes, CoreProviders, routerBasename, Shell, startCore } from "./public"

startCore()

const router = createBrowserRouter([{ path: "/", element: <Shell />, children: coreRoutes }], {
  basename: routerBasename(),
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CoreProviders>
      <RouterProvider router={router} />
    </CoreProviders>
  </StrictMode>,
)
