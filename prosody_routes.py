'Official ComfyUI custom routes for the word-tail editor.'
import asyncio
from urllib.parse import urlparse
from aiohttp import web
from . import prosody_service as service


def local_request(request):
    host = urlparse('http://' + request.host)
    if host.hostname not in ('127.0.0.1', 'localhost', '::1'):
        raise web.HTTPForbidden(text='Only local requests are allowed.')
    origin = request.headers.get('Origin')
    if origin:
        parsed = urlparse(origin)
        if parsed.scheme != request.scheme or parsed.netloc.lower() != request.host.lower():
            raise web.HTTPForbidden(text='Only same-origin local requests are allowed.')


async def reply(request, fn):
    local_request(request)
    try:
        result = await fn()
        return web.json_response(result, dumps=lambda x: __import__('json').dumps(x, ensure_ascii=False, allow_nan=False))
    except service.Conflict as error:
        return web.json_response({'error': str(error)}, status=409)
    except (ValueError, KeyError, FileNotFoundError, TypeError) as error:
        return web.json_response({'error': str(error)}, status=400)
    except Exception:
        import traceback
        traceback.print_exc()
        return web.json_response({'error': 'Processing failed. See the server logs.'}, status=500)





def register(routes, submit):
    @routes.get('/voice-workbench/default')
    async def default(request):
        from . import samples
        return await reply(request, lambda: asyncio.to_thread(samples.default_document))

    @routes.get('/voice-workbench/engines')
    async def engines(request):
        from . import configuration
        return await reply(request, lambda: asyncio.to_thread(lambda: {'engines':configuration.engines()}))

    @routes.get('/voice-workbench/document')
    async def document(request):
        return await reply(request, lambda: asyncio.to_thread(service.get_document, request.query.get('path', '')))


    @routes.post('/voice-workbench/save')
    async def save(request):
        async def run():
            body = await request.json()
            if not isinstance(body.get('document'), dict):
                raise ValueError('Submit the complete speech document.')
            return await asyncio.to_thread(service.save_document, body['path'], body['document'], body['base_revision'])
        return await reply(request, run)


    @routes.post('/voice-workbench/render')
    async def render(request):
        async def run():
            body = await request.json()
            if not isinstance(body.get('document'), dict):
                raise ValueError('Submit the complete speech document.')
            return await asyncio.to_thread(service.render_document, body['path'], body['line_id'], body['document'], body['base_revision'])
        return await reply(request, run)


    @routes.get('/voice-workbench/media')
    async def media(request):
        local_request(request)
        try:
            path = await asyncio.to_thread(service.media_path, request.query.get('document', ''), request.query.get('path', ''))
            return web.FileResponse(path, headers={'Cache-Control': 'no-cache'})
        except (ValueError, FileNotFoundError, KeyError) as error:
            raise web.HTTPBadRequest(text=str(error))


    @routes.post('/voice-workbench/performance')
    async def performance(request):
        async def run():
            from . import performance_service as performance
            body = await request.json()
            path = await asyncio.to_thread(performance.prepare, body['path'], body['line_id'], body['document'], body['base_revision'])
            try:
                result = await submit(path)
            except Exception as error:
                from pathlib import Path
                service.atomic_json(Path(path).parent/'status.json', {'state':'error', 'message':str(error)})
                raise
            return {'request_path': path, 'prompt_id': result['prompt_id']}
        return await reply(request, run)


    @routes.get('/voice-workbench/performance-status')
    async def performance_status(request):
        from . import performance_service as performance
        return await reply(request, lambda: asyncio.to_thread(performance.status, request.query['path']))


    @routes.post('/voice-workbench/performance-adopt')
    async def performance_adopt(request):
        async def run():
            from . import performance_service as performance
            body = await request.json()
            return await asyncio.to_thread(performance.adopt, body['path'], body['document'], body['base_revision'], body['candidate_path'])
        return await reply(request, run)


    @routes.get('/voice-workbench/performance-media')
    async def performance_media(request):
        local_request(request)
        from . import performance_service as performance
        try:
            path = await asyncio.to_thread(performance.media, request.query['path'])
            return web.FileResponse(path, headers={'Cache-Control': 'no-cache'})
        except (ValueError, FileNotFoundError, KeyError) as error:
            raise web.HTTPBadRequest(text=str(error))


    @routes.get('/voice-workbench/versions')
    async def versions(request):
        from . import performance_service as performance
        return await reply(request, lambda: asyncio.to_thread(performance.versions, request.query['path'], request.query['line_id']))


    @routes.post('/voice-workbench/version-save')
    async def version_save(request):
        async def run():
            from . import performance_service as performance
            body = await request.json()
            return await asyncio.to_thread(performance.save_version, body['path'], body['line_id'], body['document'], body['base_revision'])
        return await reply(request, run)


    @routes.post('/voice-workbench/version-restore')
    async def version_restore(request):
        async def run():
            from . import performance_service as performance
            body = await request.json()
            return await asyncio.to_thread(performance.restore_version, body['path'], body['line_id'], body['document'], body['base_revision'], body['version_path'])
        return await reply(request, run)


    @routes.get('/voice-workbench/version-media')
    async def version_media(request):
        local_request(request)
        from . import performance_service as performance
        try:
            path = await asyncio.to_thread(performance.version_media, request.query['path'], request.query['line_id'], request.query['version_path'])
            return web.FileResponse(path, headers={'Cache-Control':'no-cache'})
        except (ValueError, KeyError, FileNotFoundError, StopIteration) as error:
            raise web.HTTPBadRequest(text=str(error))
