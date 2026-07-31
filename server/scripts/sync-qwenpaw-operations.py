"""Configure QwenPaw's isolated ecommerce operations agent.

The Node service supplies the active text-model credentials through process
environment only. This script deliberately never accepts or prints a key.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
from pathlib import Path

from qwenpaw.config.config import (
    AgentProfileConfig,
    AgentProfileRef,
    ChannelConfig,
    MCPClientConfig,
    MCPConfig,
    ModelSlotConfig,
    ToolsConfig,
    load_agent_config,
    save_agent_config,
)
from qwenpaw.config.utils import load_config, save_config
from qwenpaw.providers import ModelInfo, ProviderInfo, ProviderManager


# QwenPaw Console restores its last selected Agent from browser storage and
# falls back to ``default``. This QwenPaw working directory belongs solely to
# the application, so the default profile is deliberately the operations
# assistant. That prevents the native component from ever reopening a broad
# tooling profile after a browser refresh.
AGENT_ID = "default"
PROVIDER_ID = "ecommerce-monitor-model"
ALLOWED_TOOLS = frozenset({"view_image"})
OPERATIONS_SKILL = "ecommerce-operations-assistant"
APPLICATION_TOOL_NAMES = [
    "get_workspace_state",
    "find_products",
    "get_product_prices",
    "capture_product_price",
    "set_product_monitoring",
    "set_sku_monitor_price",
    "retry_local_product_data",
    "get_capture_queue",
    "capture_products_batch",
    "set_global_monitor",
    "sync_product_to_feishu",
    "get_local_evidence_status",
    "get_operations_data",
    "analyze_operations_data",
    "preview_operations_report",
    "import_operations_report",
    "get_image_queue",
    "get_image_library",
    "update_image_library_item",
    "create_image_task",
    "get_agent_activity",
]


def write_workspace_files(workspace_dir: Path, context_url: str, operating_principles: str) -> None:
    workspace_dir.mkdir(parents=True, exist_ok=True)
    # QwenPaw's generic first-run bootstrap tells every new agent to inspect
    # and modify workspace identity files. This application supplies a fixed
    # purpose-built agent, so that ritual only delays a normal first message.
    (workspace_dir / "BOOTSTRAP.md").unlink(missing_ok=True)
    principles_block = (
        "## 当前运营思路（必须遵循）\n\n"
        f"{operating_principles}\n\n"
        "每一项运营建议都必须按上述思路作为判断约束。若它与当前本地数据相冲突，"
        "要明确指出冲突、说明依据并给出替代方案，不能静默忽略或擅自改写。\n\n"
        if operating_principles else
        "## 当前运营思路\n\n暂未设置额外运营思路；仍须严格依据本地数据回答。\n\n"
    )
    (workspace_dir / "AGENTS.md").write_text(
        "# 电商运营助手\n\n"
        + principles_block
        +
        "你是经营罗盘应用的本机运营 Agent。通过 ecommerce_monitor MCP 工具查询和执行应用任务。\n"
        "普通业务动作可直接执行并说明结果，包括查价、启停监控、设置监控价、重试本地解析、导入报表、经营分析和创建生图任务。\n"
        "删除商品、清空记录、删除账号、修改模型密钥和账号登录资料仍必须要求用户明确确认；这些动作不在 MCP 工具中。\n"
        "价格任务必须调用 capture_product_price 或 get_product_prices，严禁尝试访问淘宝、天猫、广告平台、浏览器、账号、Cookie、外部网页或任意本地文件。\n"
        "查价完成后必须注明账号范围、SKU 覆盖、证据时间和不可用原因；未验证价格不得猜测、不得用历史价替代当前价。\n"
        "报表附件只允许经 preview_operations_report 与 import_operations_report 从本机工作区 media 目录进入应用。\n"
        "所有金额、费率和 ROI 以工具返回的本地计算结果为准；数据过期或缺失时，要明确说明不能给出结论。\n"
        "回答使用简洁中文：先给结论，再列依据、执行回执、风险和下一步。\n",
        encoding="utf-8",
    )
    (workspace_dir / "SOUL.md").write_text(
        "你是严谨的电商运营助手。你的价值是把已导入的经营数据转成可核对、可执行的建议，"
        "不能补造数据或把推测说成事实。\n",
        encoding="utf-8",
    )
    # This workspace is application-owned. QwenPaw's initial setup copied its
    # generic browser, Office, coding and multi-agent skills here and enabled
    # them all. Their instructions made every short chat request roughly
    # 30k tokens before the model could answer. Keep only this narrow skill.
    skills_dir = workspace_dir / "skills"
    skills_dir.mkdir(exist_ok=True)
    for entry in skills_dir.iterdir():
        if entry.name == OPERATIONS_SKILL:
            continue
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()

    skill_dir = skills_dir / OPERATIONS_SKILL
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: ecommerce-operations-assistant\n"
        "description: Analyze only the local ecommerce operations context supplied by 经营罗盘.\n"
        "---\n\n"
        "# 电商运营数据分析\n\n"
        "需要本机数据或动作时，只能调用 ecommerce_monitor MCP 工具。\n"
        "工具结果是唯一事实来源；不能访问 URL、不能使用浏览器或文件工具、不能绕过本机价格取证流程。\n",
        encoding="utf-8",
    )
    # Explicitly reset the workspace skill manifest. Reconciliation keeps the
    # custom skill but must never re-enable QwenPaw's generic skill bundle.
    (workspace_dir / "skill.json").write_text(
        json.dumps({
            "schema_version": "workspace-skill-manifest.v1",
            "version": 0,
            "skills": {
                OPERATIONS_SKILL: {
                    "enabled": True,
                    "channels": ["all"],
                    "source": "customized",
                },
            },
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def locked_tools() -> ToolsConfig:
    tools = ToolsConfig()
    for name, tool in tools.builtin_tools.items():
        tool.enabled = name in ALLOWED_TOOLS
    return tools


def application_mcp(workspace_dir: Path, media_dir: str) -> MCPConfig:
    node_path = os.environ.get("ECOM_QWENPAW_NODE_PATH", "").strip()
    script_path = os.environ.get("ECOM_QWENPAW_MCP_SERVER_PATH", "").strip()
    app_url = os.environ.get("ECOM_QWENPAW_APP_URL", "").strip()
    token = os.environ.get("ECOM_QWENPAW_AGENT_TOOL_TOKEN", "").strip()
    if not node_path or not script_path or not app_url or not token:
        raise ValueError("本机应用工具桥未准备完成。")
    if not Path(script_path).is_file():
        raise ValueError("本机应用工具脚本不存在。")
    environment = {
        "ECOM_AGENT_APP_URL": app_url,
        "ECOM_AGENT_TOOL_TOKEN": token,
        "ECOM_AGENT_WORKSPACE_DIR": str(workspace_dir),
        "ECOM_AGENT_MEDIA_DIR": media_dir,
    }
    if os.environ.get("ECOM_QWENPAW_NODE_AS_NODE") == "1":
        environment["ELECTRON_RUN_AS_NODE"] = "1"
    return MCPConfig(clients={
        "ecommerce_monitor": MCPClientConfig(
            name="ecommerce_monitor",
            description="经营罗盘本机商品、价格、监控、运营数据和 AI 创作工具。",
            enabled=True,
            transport="stdio",
            command=node_path,
            args=[script_path],
            env=environment,
            cwd=str(workspace_dir),
            tools=APPLICATION_TOOL_NAMES,
        ),
    })


async def sync(args: argparse.Namespace) -> None:
    api_key = os.environ.get("ECOM_QWENPAW_API_KEY", "").strip()
    if not api_key:
        raise ValueError("文字模型尚未配置 API Key。")
    context_url = os.environ.get("ECOM_QWENPAW_CONTEXT_URL", "").strip()
    if not context_url.startswith("http://127.0.0.1:"):
        raise ValueError("本地运营数据地址无效。")
    operating_principles = os.environ.get("ECOM_QWENPAW_OPERATING_PRINCIPLES", "").strip()

    config = load_config()
    working_dir = Path(os.environ["QWENPAW_WORKING_DIR"]).expanduser()
    workspace_dir = working_dir / "workspaces" / AGENT_ID
    write_workspace_files(workspace_dir, context_url, operating_principles)

    if AGENT_ID not in config.agents.profiles:
        config.agents.profiles[AGENT_ID] = AgentProfileRef(
            id=AGENT_ID,
            workspace_dir=str(workspace_dir),
            enabled=True,
            pinned=True,
        )
    else:
        profile = config.agents.profiles[AGENT_ID]
        profile.workspace_dir = str(workspace_dir)
        profile.enabled = True
        profile.pinned = True
    for agent_id, profile in config.agents.profiles.items():
        if agent_id != AGENT_ID:
            profile.enabled = False
    config.agents.active_agent = AGENT_ID
    config.agents.agent_order = [AGENT_ID]
    save_config(config)

    manager = ProviderManager.get_instance()
    model_info = ModelInfo(id=args.model, name=args.model, supports_multimodal=True)
    provider = manager.get_provider(PROVIDER_ID)
    if provider is None:
        await manager.add_custom_provider(ProviderInfo(
            id=PROVIDER_ID,
            name="经营罗盘文字模型",
            base_url=args.base_url,
            api_key=api_key,
            chat_model="OpenAIChatModel",
            extra_models=[model_info],
        ))
    else:
        manager.update_provider(PROVIDER_ID, {
            "name": "经营罗盘文字模型",
            "base_url": args.base_url,
            "api_key": api_key,
            "chat_model": "OpenAIChatModel",
            "extra_models": [model_info],
        })
    await manager.activate_model(PROVIDER_ID, args.model)

    try:
        agent = load_agent_config(AGENT_ID)
    except Exception:
        agent = AgentProfileConfig(
            id=AGENT_ID,
            name="运营助手",
            description="管理本机商品监控、经营数据分析与 AI 创作任务。",
            workspace_dir=str(workspace_dir),
            channels=ChannelConfig(),
            mcp=MCPConfig(clients={}),
        )
    agent.name = "运营助手"
    agent.description = "管理本机商品监控、经营数据分析与 AI 创作任务。"
    agent.workspace_dir = str(workspace_dir)
    agent.language = "zh"
    agent.active_model = ModelSlotConfig(provider_id=PROVIDER_ID, model=args.model)
    agent.approval_level = "AUTO"
    agent.system_prompt_files = ["AGENTS.md", "SOUL.md"]
    channels = agent.channels or ChannelConfig()
    channels.console.enabled = True
    # Preserve the user's QwenPaw-native Feishu credentials. Group messages
    # must mention the bot, while direct messages can continue normally.
    channels.feishu.require_mention = True
    channels.feishu.share_session_in_group = False
    channels.feishu.media_dir = channels.feishu.media_dir or str(workspace_dir / "media")
    agent.channels = channels
    agent.mcp = application_mcp(workspace_dir, channels.feishu.media_dir)
    agent.tools = locked_tools()
    agent.heartbeat = None
    agent.acp = None
    agent.plan.enabled = False
    agent.coding_mode.enabled = False
    # A generated chat title costs another model request and is irrelevant in
    # the embedded operations assistant. Disable it for lower first-turn latency.
    agent.running.auto_title_config.enabled = False
    agent.running.max_iters = 8
    # Normal operations questions should never inherit a 128K chat window.
    # The narrow Agent is stateless beyond the current task, and a bounded
    # native context keeps first-token latency predictable after long chats.
    agent.running.max_input_length = 16_000
    agent.running.light_context_config.context_compact_config.enabled = True
    agent.running.light_context_config.context_compact_config.compact_threshold_ratio = 0.6
    agent.running.light_context_config.context_compact_config.reserve_threshold_ratio = 0.15
    agent.running.light_context_config.tool_result_pruning_config.pruning_recent_n = 1
    agent.running.light_context_config.tool_result_pruning_config.pruning_recent_msg_max_bytes = 12_000
    agent.running.light_context_config.tool_result_pruning_config.pruning_old_msg_max_bytes = 2_000
    # This is an operational chat, not an autonomous coding agent. Long-term
    # memory and scroll/recall instructions only add latency and can pull an
    # unrelated prior session into a simple question.
    agent.running.context_manager_backend = "light"
    agent.running.light_context_config.strategy = "native"
    agent.running.memory_manager_backend = "none"
    save_agent_config(AGENT_ID, agent)

    # Deliberately omit base URL and API key from stdout as this becomes a
    # response body in the local application.
    print(json.dumps({"ok": True, "agentId": AGENT_ID, "model": args.model}, ensure_ascii=False))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    try:
        asyncio.run(sync(args))
    except Exception as error:
        print(json.dumps({"ok": False, "message": str(error)[:300]}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
