# syntax=docker/dockerfile:1

# ---- 构建阶段：安装依赖、运行测试、构建前端与后端 ----
FROM node:20-alpine AS build
WORKDIR /app

# 先拷贝清单，利用层缓存
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

# 拷贝源码并构建（测试失败会中断镜像构建）
COPY shared ./shared
COPY server ./server
COPY client ./client
RUN npm run test && npm run build

# ---- 运行阶段：仅包含构建产物，无需 node_modules ----
FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
