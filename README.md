
# StudySpace — Полный проект

## Структура
```
studyspace/
├── index.html          ← Фронтенд (открыть в браузере)
├── manage.py
└── node/
    ├── node_modules/
    ├── package.json
    ├── package-lock.json
    └── server.js       ← REST API на Node.js / Express
```

## Запуск бэкенда

```bash
cd node
npm install
npm start
# API запустится на http://localhost:3000
```

Для режима разработки (авто-рестарт):
```bash
cd node
npm run dev
```

## API Endpoints

| Метод  | Путь                            | Описание                       |
|--------|---------------------------------|--------------------------------|
| GET    | /api/health                     | Проверка работы сервера        |
| GET    | /api/stats                      | Глобальная статистика          |
| GET    | /api/places                     | Все места (фильтры: city, type, wifi, quietZone) |
| GET    | /api/places/:id                 | Одно место                     |
| GET    | /api/rooms                      | Активные учебные комнаты       |
| POST   | /api/rooms                      | Создать комнату                |
| POST   | /api/rooms/:id/join             | Войти в комнату                |
| POST   | /api/rooms/:id/leave            | Выйти из комнаты               |
| POST   | /api/pomodoro/start             | Начать помодоро-сессию         |
| POST   | /api/pomodoro/:id/complete      | Завершить сессию               |
| GET    | /api/pomodoro/:id               | Статус сессии                  |

## Примеры запросов

```bash
# Получить все места в Алматы
curl "http://localhost:3000/api/places?city=Алматы"

# Создать комнату
curl -X POST http://localhost:3000/api/rooms \
  -H "Content-Type: application/json" \
  -d '{"name":"My Study Room","host":"Арман","subject":"Физика"}'

# Начать помодоро
curl -X POST http://localhost:3000/api/pomodoro/start \
  -H "Content-Type: application/json" \
  -d '{"userId":"user123","workMinutes":25}'
```

## Фронтенд
Откройте `index.html` в браузере.  
Фронтенд автоматически подключается к `http://localhost:3000/api`.  
Индикатор «API онлайн/офлайн» в правом нижнем углу показывает статус соединения.