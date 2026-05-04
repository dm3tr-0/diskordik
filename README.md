# diskordik

> self-hosted discord — лёгкий мессенджер для команды, который вы поднимаете сами

**diskordik** — это попытка сделать простой, но рабочий аналог Discord, который работает без vpn и zapret, не шлёт телеметрию и не пытается продать Nitro. Просто поднимаете на своём сервере — и общаетесь.
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

Windows
```bash
git clone https://github.com/dm3tr-0/diskordik.git
cd diskordik
py -3.10 -m venv venv
venv/Scripts/Activate.ps1
pip install -r requirements.txt
python app.py
```

Linux
```bash
sudo apt install -y make build-essential libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev wget curl llvm libncurses5-dev libncursesw5-dev xz-utils tk-dev libffi-dev liblzma-dev git
curl https://pyenv.run | bash
echo 'export PATH="$HOME/.pyenv/bin:$PATH"' >> ~/.bashrc
echo 'eval "$(pyenv init --path)"' >> ~/.bashrc
echo 'eval "$(pyenv virtualenv-init -)"' >> ~/.bashrc
source ~/.bashrc
pyenv install 3.10.14
pyenv global 3.10.14
git clone https://github.com/dm3tr-0/diskordik.git
cd diskordik
python -m venv venvsource venv/bin/activate
pip install -r requirements.txt
python app.py
```
