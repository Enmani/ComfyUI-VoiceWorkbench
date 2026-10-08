"""Run the shared workbench locally without installing ComfyUI."""
import argparse
import asyncio
import importlib.util
import os
import sys
import uuid
from pathlib import Path
from aiohttp import web

ROOT = Path(__file__).resolve().parent
os.environ['VOICE_WORKBENCH_STANDALONE'] = '1'
spec = importlib.util.spec_from_file_location('voice_workbench', ROOT/'__init__.py',
                                            submodule_search_locations=[str(ROOT)])
package = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = package
spec.loader.exec_module(package)
from voice_workbench import configuration, host, performance_service, prosody_routes


def create_app():
    app = web.Application(client_max_size=1024*1024)
    routes = web.RouteTableDef()
    pending = asyncio.Queue(maxsize=8)
    history = {}
    running = {}
    waiting = {}

    async def submit(path):
        if pending.full():
            raise ValueError('Generation queue is full. Wait for a take to finish.')
        ticket = uuid.uuid4().hex
        pending.put_nowait((ticket, path))
        waiting[ticket] = path
        return {'prompt_id':ticket}

    async def worker():
        while True:
            ticket, path = await pending.get()
            waiting.pop(ticket, None)
            running[ticket] = path
            try:
                await asyncio.to_thread(performance_service.execute, path)
                history[ticket] = {'status':{'status_str':'success'}}
            except Exception:
                import traceback
                traceback.print_exc()
                history[ticket] = {'status':{'status_str':'error'}}
            finally:
                running.pop(ticket, None)
                pending.task_done()
                if len(history) > 256:
                    history.pop(next(iter(history)))

    async def lifecycle(app):
        host.stopping.clear()
        task = asyncio.create_task(worker())
        yield
        host.stopping.set()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    app.cleanup_ctx.append(lifecycle)
    prosody_routes.register(routes, submit)

    @routes.get('/')
    async def index(request):
        prosody_routes.local_request(request)
        return web.FileResponse(ROOT/'demo/index.html')

    @routes.get('/history/{ticket}')
    async def get_history(request):
        prosody_routes.local_request(request)
        ticket = request.match_info['ticket']
        return web.json_response({ticket:history[ticket]} if ticket in history else {})

    @routes.get('/queue')
    async def queue(request):
        prosody_routes.local_request(request)
        # Only ticket IDs are exposed; no model commands or other users' paths.
        return web.json_response({'queue_running':[[0,ticket] for ticket in running],
                                  'queue_pending':[[0,ticket] for ticket in waiting]})

    app.add_routes(routes)
    app.router.add_static('/web', ROOT/'web')
    app.router.add_static('/demo', ROOT/'demo')
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8794)
    parser.add_argument('--workspace', type=Path)
    args = parser.parse_args()
    if args.workspace:
        if 'voice_workbench.prosody_service' in sys.modules:
            # CLI configuration must be set before services resolve the workspace.
            from voice_workbench import prosody_service
            prosody_service.JOBS = args.workspace.expanduser().resolve()/'jobs'
        os.environ['VOICE_WORKBENCH_HOME'] = str(args.workspace.expanduser().resolve())
    print(f'Voice Workbench: http://127.0.0.1:{args.port}/', flush=True)
    web.run_app(create_app(), host='127.0.0.1', port=args.port)
