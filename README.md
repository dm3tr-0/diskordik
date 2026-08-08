# diskordik

> self-hosted discord — лёгкий мессенджер для команды, который вы поднимаете сами

**diskordik** — это попытка сделать простой, но рабочий аналог Discord, который работает без vpn и zapret, не шлёт телеметрию и не пытается продать Nitro. Просто поднимаете на своём сервере — и общаетесь.
<br>
<p>бета-тест:</p>
<p>https://chat.dm3tr0.ru (upd 09.08.2026 недоступно ❌) </p>
<p>https://russian-node.dm3tr0.ru (upd 09.08.2026 недоступно ❌)</p>
<img width="1104" height="945" alt="изображение" src="https://github.com/user-attachments/assets/2c966fe6-99a7-47d1-ba61-18a03526913f" />
<img width="1656" height="995" alt="изображение" src="https://github.com/user-attachments/assets/c90eb2d0-a256-4c29-9ba2-8869e9afe4ea" />

---

## 🚀 Возможности

- Текстовые каналы
- Голосовые каналы
- Self-hosted: все данные только на вашем сервере
- Адаптивный веб-интерфейс (работает с телефона и ПК)
- Полностью открытый код — можно допилить под себя
  
---

## 🛠️ Технологии

| Компонент | Технология |
|-----------|------------|
| Бэкенд | Python 3.10 |
| База данных | SQLite |
| Голос/видео | WebRTC |
| Фронтенд | HTML5, CSS3, JS |

---

## 📦 Установка

Linux
```bash
curl -sSL https://raw.githubusercontent.com/dm3tr-0/diskordik/main/install.sh | bash
```

Windows
```bash
git clone https://github.com/dm3tr-0/diskordik.git
cd diskordik
py -3.10 -m venv venv
venv/Scripts/Activate.ps1
pip install -r requirements.txt
python app.py
```
