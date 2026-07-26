# -*- coding: utf-8 -*-
"""Short-lived QR image delivery through QwenPaw's native Feishu channel."""

from __future__ import annotations

import base64
import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field
from qwenpaw.plugins.api import PluginApi
from qwenpaw.schemas import ContentType, ImageContent

logger = logging.getLogger(__name__)
router = APIRouter()
MAX_QR_BYTES = 2 * 1024 * 1024


class SendQrRequest(BaseModel):
    target_user: str = Field(min_length=1, max_length=500)
    target_session: str = Field(min_length=1, max_length=500)
    image_base64: str = Field(min_length=16, max_length=MAX_QR_BYTES * 2)


class RetractQrRequest(BaseModel):
    message_id: str = Field(min_length=1, max_length=500)


async def _feishu_channel(request: Request, agent_id: str):
    manager = getattr(request.app.state, "multi_agent_manager", None)
    if manager is None:
        raise HTTPException(status_code=503, detail="QwenPaw agent is not ready")
    workspace = await manager.get_agent(agent_id or "default")
    channel_manager = workspace.channel_manager
    channel = await channel_manager.get_channel("feishu") if channel_manager else None
    if channel is None:
        raise HTTPException(status_code=409, detail="QwenPaw Feishu channel is not connected")
    return channel


@router.post("/send")
async def send_qr(
    payload: SendQrRequest,
    request: Request,
    x_agent_id: Optional[str] = Header(None, alias="X-Agent-Id"),
):
    try:
        raw = base64.b64decode(payload.image_base64, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="Invalid QR image") from exc
    if not raw or len(raw) > MAX_QR_BYTES or not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(status_code=422, detail="QR image must be a PNG smaller than 2 MB")
    channel = await _feishu_channel(request, x_agent_id or "default")
    to_handle = channel.to_handle_from_target(
        user_id=payload.target_user,
        session_id=payload.target_session,
    )
    message_id = await channel.send_content_parts(
        to_handle,
        [ImageContent(
            type=ContentType.IMAGE,
            image_url="data:image/png;base64," + payload.image_base64,
            filename="taobao-login-qr.png",
        )],
        {"_api_send": True, "agent_id": x_agent_id or "default"},
    )
    if not message_id:
        raise HTTPException(status_code=502, detail="Feishu QR image delivery failed")
    return {"success": True, "message_id": message_id}


@router.post("/retract")
async def retract_qr(
    payload: RetractQrRequest,
    request: Request,
    x_agent_id: Optional[str] = Header(None, alias="X-Agent-Id"),
):
    channel = await _feishu_channel(request, x_agent_id or "default")
    client = getattr(channel, "_client", None)
    if client is None:
        raise HTTPException(status_code=409, detail="QwenPaw Feishu channel is not connected")
    try:
        from lark_oapi.api.im.v1 import DeleteMessageRequest
        response = await client.im.v1.message.adelete(
            DeleteMessageRequest.builder().message_id(payload.message_id).build(),
        )
        if not response.success():
            raise RuntimeError(getattr(response, "msg", "Feishu message retraction failed"))
    except Exception as exc:
        logger.warning("Could not retract QR message: %s", exc)
        raise HTTPException(status_code=502, detail="Feishu QR message retraction failed") from exc
    return {"success": True}


class EcommerceQrDeliveryPlugin:
    def register(self, api: PluginApi):
        api.register_http_router(router, prefix="/ecommerce-qr-delivery", tags=["ecommerce-qr-delivery"])


plugin = EcommerceQrDeliveryPlugin()
