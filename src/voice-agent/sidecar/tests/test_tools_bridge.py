import asyncio

from ow_conversation.tools_bridge import ToolBridge, ToolOutcome


class FakeLink:
    def __init__(self) -> None:
        self.sent: list[tuple[str, dict, str | None]] = []

    async def send(self, type_: str, data: dict, *, id: str | None = None) -> None:
        self.sent.append((type_, data, id))


def test_a_call_waits_for_the_result_with_the_same_id():
    async def scenario():
        link = FakeLink()
        bridge = ToolBridge(link.send)
        task = asyncio.create_task(bridge.call("open_app", {"name": "Obsidian"}))
        await asyncio.sleep(0)
        (type_, data, call_id) = link.sent[0]
        assert type_ == "tool.call"
        assert data == {"name": "open_app", "arguments": {"name": "Obsidian"}}
        assert bridge.resolve("tc-unknown", {"success": True}) is False
        assert bridge.resolve(call_id, {"success": True, "text": "Obsidian is open."}) is True
        outcome = await task
        assert outcome == ToolOutcome(True, "Obsidian is open.")
        assert bridge.pending_count == 0

    asyncio.run(scenario())


def test_a_silent_executor_times_out_and_the_call_is_cancelled():
    async def scenario():
        link = FakeLink()
        bridge = ToolBridge(link.send, timeout_s=0.05)
        outcome = await bridge.call("run_powershell", {"script": "Get-Date"})
        assert outcome.success is False
        assert [m[0] for m in link.sent] == ["tool.call", "tool.cancel"]
        assert link.sent[0][2] == link.sent[1][2]
        assert bridge.pending_count == 0

    asyncio.run(scenario())


def test_ending_the_session_releases_every_waiting_call():
    async def scenario():
        link = FakeLink()
        bridge = ToolBridge(link.send)
        tasks = [asyncio.create_task(bridge.call("get_note", {"id": i})) for i in range(2)]
        await asyncio.sleep(0)
        bridge.cancel_all("stopped")
        outcomes = await asyncio.gather(*tasks)
        assert outcomes == [ToolOutcome(False, "stopped")] * 2
        call_id = link.sent[0][2]
        assert bridge.resolve(call_id, {"success": True}) is False

    asyncio.run(scenario())
