FROM python:3.11-slim-bookworm

ARG LAYA_VERSION=0.3.21
ARG TORCH_VERSION=2.14.0

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TORCH_DISABLE_NATIVE_JIT=1 \
    USE_TF=0 \
    TOKENIZERS_PARALLELISM=false \
    HF_HOME=/home/laya/.cache/huggingface

# Install CPU wheels first to avoid pulling CUDA dependencies.
RUN pip install "torch==${TORCH_VERSION}" --index-url https://download.pytorch.org/whl/cpu \
    && pip install "laya[serve]==${LAYA_VERSION}" \
    && pip check

RUN groupadd --gid 10001 laya \
    && useradd --uid 10001 --gid laya --create-home laya \
    && mkdir -p /home/laya/.cache/huggingface \
    && chown -R laya:laya /home/laya/.cache

USER laya
WORKDIR /home/laya
EXPOSE 8000
CMD ["laya-serve"]
