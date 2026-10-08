"""The host owns queueing and cancellation; audio services do not import ComfyUI."""
import threading

stopping = threading.Event()
check_cancelled = lambda: None
release_models = lambda: None


def check_interrupted():
    if stopping.is_set():
        raise RuntimeError('The server is stopping.')
    check_cancelled()


def configure_comfy():
    global check_cancelled, release_models
    import comfy.model_management as mm
    check_cancelled = mm.throw_exception_if_processing_interrupted

    def release():
        mm.unload_all_models()
        mm.soft_empty_cache()
    release_models = release
