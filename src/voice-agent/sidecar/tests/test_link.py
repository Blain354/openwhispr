import asyncio
import json

import pytest
from websockets.asyncio.server import serve

from ow_conversation.link import Link


def envelope(message_type, data=None, **extra):
    return json.dumps({"v": 1, "type": message_type, "ts": 0, "data": data or {}, **extra})


def test_only_loopback_urls_and_a_token_are_accepted():
    with pytest.raises(ValueError):
        Link("ws://192.168.0.10:8241", "t")
    with pytest.raises(ValueError):
        Link("ws://127.0.0.1:8241", "")


def test_the_link_authenticates_waits_for_config_and_dispatches():
    async def scenario():
        seen = {}
        received = []

        async def server_handler(connection):
            seen["authorization"] = connection.request.headers.get("Authorization")
            seen["origin"] = connection.request.headers.get("Origin")
            received.append(json.loads(await connection.recv()))
            await connection.send("not json")
            await connection.send(envelope("hello"))  # not an app message type: skipped
            await connection.send(envelope("session.config", {"sttLanguage": "auto"}))
            await connection.send(envelope("tool.result", {"success": True}, id="tc-1"))
            await connection.send(envelope("shutdown"))

        async with serve(server_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            link = Link(f"ws://127.0.0.1:{port}", "secret-token")
            await link.open()
            await link.send("hello", {"protocol": 1})
            config = await link.wait_for("session.config", timeout_s=5)
            assert config["data"] == {"sttLanguage": "auto"}

            results = []
            done = asyncio.Event()

            async def on_shutdown(_message):
                done.set()

            runner = asyncio.create_task(
                link.run({"tool.result": results.append, "shutdown": on_shutdown})
            )
            await asyncio.wait_for(done.wait(), 5)
            await link.close()
            await asyncio.wait_for(runner, 5)

        assert seen == {"authorization": "Bearer secret-token", "origin": None}
        assert received[0]["type"] == "hello" and received[0]["v"] == 1
        assert [r["id"] for r in results] == ["tc-1"]

    asyncio.run(scenario())
