"""ComfyUI Voice Workbench nodes and shared HTTP routes."""
WEB_DIRECTORY = './web'


class VoiceEditor:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'document_path':('STRING', {'default':''}),
                             'line_id':('STRING', {'default':'line-1'})}}

    RETURN_TYPES = ('STRING',)
    RETURN_NAMES = ('preview_audio',)
    FUNCTION = 'preview'
    CATEGORY = 'audio/Voice Workbench'
    OUTPUT_NODE = True

    def preview(self, document_path, line_id):
        from . import samples, prosody_service
        if not document_path:
            document_path = samples.default_document()['document_path']
        result = prosody_service.render_document(document_path, line_id)
        return (result['result']['audio'],)


class GeneratePerformance:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{'request_path':('STRING', {'default':''})}}
    RETURN_TYPES = ('STRING',)
    RETURN_NAMES = ('candidate_path',)
    FUNCTION = 'generate'
    CATEGORY = 'audio/Voice Workbench'
    OUTPUT_NODE = True

    def generate(self, request_path):
        from . import performance_service
        return (performance_service.execute(request_path),)


NODE_CLASS_MAPPINGS = {'VWVoiceEditor':VoiceEditor, 'VWGeneratePerformance':GeneratePerformance}
NODE_DISPLAY_NAME_MAPPINGS = {'VWVoiceEditor':'Voice Workbench · Time & Pitch',
                              'VWGeneratePerformance':'Voice Workbench · Generate Take'}


def register_comfy():
    import aiohttp
    from server import PromptServer
    from . import host, prosody_routes
    host.configure_comfy()

    async def submit(path):
        server = PromptServer.instance
        port = server.port or 8188
        prompt = {'1':{'class_type':'VWGeneratePerformance', 'inputs':{'request_path':path}}}
        async with aiohttp.ClientSession() as session:
            async with session.post(f'http://127.0.0.1:{port}/prompt', json={'prompt':prompt},
                                    timeout=aiohttp.ClientTimeout(total=15)) as response:
                data = await response.json()
                if response.status != 200:
                    raise ValueError('ComfyUI did not accept the generation task: ' + str(data.get('error')))
                return data
    prosody_routes.register(PromptServer.instance.routes, submit)


# Standalone imports use the same services without requiring a ComfyUI installation.
if __import__('os').environ.get('VOICE_WORKBENCH_STANDALONE') != '1':
    register_comfy()
