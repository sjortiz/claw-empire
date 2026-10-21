import { request } from "./core";

import type { HeadroomStatus } from "../lib/headroom";

export function getHeadroomStatus(signal?: AbortSignal): Promise<HeadroomStatus> {
  return request<HeadroomStatus>("/api/headroom/status", { signal });
}
