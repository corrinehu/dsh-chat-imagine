# dsh-chat-imagine

[English](./README.en.md) | 中文

实现了在 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的聊天窗口中自动调用生图工具（API 渠道，或本机 CLI：已支持mmx / codex / agy）并展示图片，也支持利用对应 CLI 识别图片。

![在 DSH 对话中生成的图片](assets/1.png)

## 说明

支持 API 和 CLI 两种方式：

### API

- 使用 DSH 中已配置的 OpenAI 兼容接口，从中查找可用的生图模型。

- 内置渠道（如 OpenRouter）在 DSH 设置里未填写 base URL 时，插件会自动使用 DSH 内置的默认地址，与聊天路由的行为一致。

### CLI

插件会扫描本机是否安装了 MiniMax CLI（`mmx`）、OpenAI Codex CLI（`codex`）、Google Antigravity CLI（`agy`）；找到的都会作为可用的生成图片和识别图片的渠道。

#### 生成图片

- 调用 `codex` 消耗的是 **ChatGPT 账号（Plus/Pro）额度**，而非 API key；需已安装 codex CLI，并登录有生图额度的账号（`codex login status` 可查）。
- 调用 `agy` 消耗的是 **Google 账号额度**；需已安装 agy CLI，并在 Antigravity App 里保持登录。
- 探测到 codex / agy 时，插件还会随包注册技能 **`cli-image-gen`**，教模型在 `generate_image` 工具失败（额度/区域限制/解析失败）时驱动 CLI 生图，以及收尾用 `show_image_file` 内联展示。

#### 识别图片

- 识别走的是**同一个 CLI 渠道的视觉能力**（`mmx` 的 vision describe / `codex` 的 `exec -i` 附图 + 服务端 JSON schema / `agy` 的 `--json-schema`），所以**装了 mmx / codex / agy 任意一个即可识图**，无需全装；一个都没装时插件照常工作，只是 `analyze_image` 会返回「未发现 CLI，不支持识图」。
- 把图片（本地路径或 http(s) URL）读取成**结构化 JSON 证据**：OCR 全文与逐行文本、按阅读顺序的版面区域、语义实体与关系、视觉线索、不确定项清单：任何模型（含纯文本模型）都能直接调用，无需切换到视觉模型。
- 渠道自动按速度选（`mmx` → `codex` → `agy`），也可用 `set_image_default` 的 `visionBackend` 参数固定默认识图渠道。

## 安装

```sh
dsh plugin --profile web add github:corrinehu/dsh-chat-imagine
```

## 使用

安装启用插件后，在新对话里直接说你想画什么，例如：

```text
帮我生成一个 Q 版蓝鲸 Logo
```

插件会检索可用的渠道和模型，并询问默认生图的渠道：

![首次生成时选择默认渠道](assets/2.png)

设置后，不必重复选择。之后，直接在聊天里描述你想要的图片：

```text
生成一张 16:9 的雪山日出
```

生成结果会直接显示在聊天中。

也可使用其他生图渠道：

![选择非默认渠道](assets/3.png)

在对话中直接说明即可，例如：

```text
用 agy 生成一张手绘彩铅风格说明大模型后训练的宽屏图片
```

![agy 生成图片](assets/4.png)


## 识图（读图）

识图能力**依赖本机 CLI**：装了 mmx / codex / agy 任意一个，`analyze_image` 工具即可用（三者任一即可，无需全装）；一个都没装时插件照常工作，只是不提供识图——调用会返回「未发现 CLI」的说明。装好后工具把图片（本地路径或 http(s) URL）读取成**结构化 JSON 证据**——OCR 全文与逐行文本、按阅读顺序排列的版面区域、语义实体与关系、视觉线索、不确定项清单。

```text
帮我读一下这张图 /tmp/screenshots/error.png，把报错原文抄出来
```

- **任何模型可用**：工具走 CLI 渠道的视觉模型（MiniMax VLM / ChatGPT / Gemini），当前会话不需要切换到视觉模型——这是与 modlens 那类「接管模型路由」方案的主要区别。
- **契约借鉴 modlens**：同一份证据结构（五段式），刻意不含坐标框与置信度（视觉模型最容易编造的字段）。
- **渠道选择**：`mmx`（最快，直连 VLM，约 3-8 秒）→ `codex`（服务端强制 JSON schema，最稳）→ `agy`（Gemini，额度周桶共享）。可用 `set_image_default` 的 `visionBackend` 参数固定默认识图渠道，不设则自动按速度选。
- **失败降级**：某渠道额度耗尽时，对话里说明换一个即可（`backend` 参数或直接说「用 codex 读」）。

## 注意事项

- 当前仅在 DSH Web profile 中测试通过。
- 图片只保存在 DSH 进程内存中；重启后历史图片链接会失效。需要保留时请从聊天界面保存。

## 许可证

[MIT](./LICENSE)
