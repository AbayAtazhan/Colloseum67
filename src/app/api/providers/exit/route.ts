import type { NextRequest } from "next/server";
import { handleProviderRequest } from "../_lib";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: NextRequest) => handleProviderRequest(request, "exit");
