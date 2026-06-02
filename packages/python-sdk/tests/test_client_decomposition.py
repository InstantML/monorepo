import os
import subprocess
import sys
from pathlib import Path

import instantml as ro
import instantml.client as client_module
import instantml.log_payload as log_payload
import instantml.media as media
import instantml.objects as objects


def test_client_facade_exports_extracted_modules() -> None:
    assert client_module.Table is objects.Table
    assert client_module.Histogram is objects.Histogram
    assert client_module.ClassificationEval is objects.ClassificationEval
    assert client_module.File is objects.File
    assert client_module.Artifact is objects.Artifact
    assert client_module.CheckpointPolicy is objects.CheckpointPolicy
    assert client_module.Text is objects.Text
    assert client_module.Image is objects.Image
    assert client_module.Video is objects.Video
    assert client_module.Audio is objects.Audio
    assert client_module._histogram_from_count is objects._histogram_from_count
    assert client_module._histogram_counts_for_edges is objects._histogram_counts_for_edges

    assert client_module._is_local_file_uri is media._is_local_file_uri
    assert client_module._strip_file_uri is media._strip_file_uri
    assert client_module._FileStats is media._FileStats
    assert client_module._hash_file is media._hash_file
    assert client_module._write_image_data is media._write_image_data
    assert client_module._write_audio_data is media._write_audio_data
    assert client_module._write_video_data is media._write_video_data

    assert client_module._classify_log_payload is log_payload._classify_log_payload
    assert client_module._classify_log_sequence is log_payload._classify_log_sequence
    assert client_module._validate_rank_context is log_payload._validate_rank_context
    assert client_module._validate_rank_weight is log_payload._validate_rank_weight


def test_public_extracted_classes_preserve_client_module_identity() -> None:
    for cls in (
        ro.Table,
        ro.Histogram,
        ro.File,
        ro.Artifact,
        ro.CheckpointPolicy,
        ro.Text,
        ro.Image,
        ro.Video,
        ro.Audio,
    ):
        assert cls.__module__ == "instantml.client"


def test_import_smoke_for_extracted_modules_avoids_optional_dependencies() -> None:
    sdk_root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{sdk_root}{os.pathsep}{env.get('PYTHONPATH', '')}"
    script = """
import sys
import instantml
import instantml.client
import instantml.uploader
import instantml.objects
import instantml.media
import instantml.log_payload

optional = {'PIL', 'numpy', 'soundfile', 'imageio', 'moviepy', 'psutil', 'pynvml'}
loaded = optional.intersection(sys.modules)
assert not loaded, sorted(loaded)
"""
    subprocess.run([sys.executable, "-c", script], env=env, check=True)


def test_run_media_materialization_uses_client_facade_monkeypatch(monkeypatch, tmp_path) -> None:
    calls = []
    run = client_module.Run(
        client=client_module.Client(base_url="http://example.test"),
        run_id="run-1",
        upload_mode="sync",
        media_dir=str(tmp_path),
    )

    def fake_write_image_data(data, target):
        calls.append((data, target))
        target.write_bytes(b"image")

    monkeypatch.setattr(client_module, "_write_image_data", fake_write_image_data)

    materialized = run._materialize_media_source(ro.Image.from_data("payload"))

    assert materialized.parent == tmp_path
    assert materialized.read_bytes() == b"image"
    assert calls == [("payload", materialized)]
