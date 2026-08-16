# dsh-chat-imagine

[English](./README.en.md) | 中文

插件实现了在 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的聊天窗口中自动调用已有的生图工具，生成图片并展示。

![在 DSH 对话中生成的图片](assets/2.png)

### 说明

支持 API 和 CLI 两种生图方式：

- **API**：使用 DSH 中已配置的 OpenAI 兼容接口，从中查找可用的生图模型。
- **CLI**：扫描本机是否安装了 MiniMax CLI（`mmx`）；如果找到，也会将其作为可用的生图渠道。

内置渠道（如 OpenRouter）在 DSH 设置里未填写 base URL 时，插件会自动使用 DSH 内置的默认地址，与聊天路由的行为一致。

### 安装

```sh
dsh plugin --profile web add github:corrinehu/dsh-chat-imagine
```

## 使用

安装启用插件后，在新对话里直接说你想画什么，例如：

```text
帮我生成一个 Q 版蓝鲸 Logo
```

插件会检索可用的渠道和模型，并询问默认生图的渠道：

![首次生成时选择默认渠道](assets/1.png)

设置后，不必重复选择。其后，直接在聊天里描述你想要的图片：

```text
生成一张 16:9 的雪山日出
画一张适合技术博客封面的极简插画
```

生成结果会直接显示在聊天中。

也可使用其他生图渠道，例如：


![选择非默认渠道](assets/3.png)

对话中直接说明即可

```text
用 gpt 模型帮我生成一张公众号封面
```


## 注意事项

- 当前仅在 DSH Web profile 中测试通过。
- 图片只保存在 DSH 进程内存中；重启后历史图片链接会失效。需要保留时请从聊天界面保存。

## 许可证

[MIT](./LICENSE)
