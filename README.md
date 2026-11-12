# 글로벌 술래잡기

친구들과 실제 위치(GPS)로 하는 술래잡기 웹게임이에요.
모드는 술래잡기, 숨바꼭질, 경찰과 도둑, 좀비감염 네 가지예요.

## 구조
- `public/index.html` : 게임 화면 전부 (시작 · 대기실 · 경기장 편집 · 게임 · 결과)
- `src/worker.js` : 서버. Cloudflare Worker + Durable Object (방 하나 = 객체 하나)
- `wrangler.jsonc` : Cloudflare 배포 설정

## 배포 (Cloudflare, 무료 플랜)
1. Cloudflare 대시보드 → Workers & Pages → Create → **Import a repository**
2. 이 저장소(global-tag) 선택
3. Build command는 비워 두고, Deploy command는 `npx wrangler deploy` 그대로 두기
4. Deploy → `global-tag.<계정>.workers.dev` 주소가 생겨요
5. 이후로는 GitHub에 올리기만 하면 자동으로 다시 배포돼요

## 내 컴퓨터에서 실행
```
npm install
npx wrangler dev
```
→ http://localhost:8787

## 참고
- 위치 기능은 https 주소(또는 localhost)에서만 켜져요.
- 지도: Leaflet + OpenStreetMap
- 위치 기록과 사진은 다음 판을 시작하거나 방이 비고 2시간이 지나면 삭제돼요.
