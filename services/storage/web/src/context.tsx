import { createContext, useContext } from "react";
import type { Me } from "./api";

export interface UploadTarget { id: string; name: string }

export interface AppCtx {
  me: Me;
  /** The folder that drops and the Upload button send files to (null when the page can't take uploads). */
  setUploadTarget: (t: UploadTarget | null) => void;
  uploads: { add: (files: { file: File; relPath: string }[], parentId: string, parentName: string) => void };
}

export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(AppContext);
  if (!c) throw new Error("useApp outside the app");
  return c;
}
