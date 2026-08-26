# Bank Studio Web

一个用于编辑《火影忍者》游戏 `.bank` 音频文件的 Web 工具。

## 功能

- 导入游戏 `.bank` 文件（RIFF/FEV 容器 + 内嵌 FSB5）
- 预览和编辑音频样本
- 替换音频并导出
- 自动同步容器时长标记

## 技术栈

- Vue 3 + TypeScript
- Vite
- @arkntools/fmod（FMOD WASM 浏览器版）
- vorbis-encoder-js

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建单文件版本
npm run build:single

# 类型检查
npm run type-check
```

## 使用

1. 打开 `bank-studio-web-single.html` 或访问部署的网页
2. 导入游戏的 `.bank` 文件
3. 选择要替换的音频样本
4. 导出修改后的文件
5. 将导出文件放回游戏目录

## 注意事项

- 导出的 `.bank` 文件需要放回游戏对应目录才能生效
- 替换音频时会自动匹配 Vorbis 编码参数以保证兼容性
- 工具内预览正常但游戏无声时，检查文件是否正确覆盖

## 许可证

MIT
