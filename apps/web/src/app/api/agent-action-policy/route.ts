import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 5041 ② — what an agent may do on its own, set by the user: read the effective levels of one agent in one project · set one · take one back. The server decides who may (an
// organisation owner / admin's PERSON session) and answers 403 to everyone else; the query string (project_id · agent_id · action_key) travels with the request.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/agent-action-policy');
}

export async function PUT(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/agent-action-policy');
}

export async function DELETE(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/agent-action-policy');
}
