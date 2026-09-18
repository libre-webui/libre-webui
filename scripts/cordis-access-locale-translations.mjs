/**
 * Translations for the Cordis engine administrator opt-in.
 *
 * Kept as reviewable data, like the page translations: the locale parity test
 * requires every shipped locale to carry exactly the English keys, so one
 * missing key breaks the build.
 */
export const CORDIS_ACCESS_TRANSLATIONS = {
  de: {
    title: 'Cordis-Engine',
    description:
      'Die Cordis-Engine für Administratoren anbieten. Sie führt Werkzeuge mit echtem Dateisystemzugriff aus, der nicht über die Werkzeugfreigabe von Libre WebUI läuft.',
    saved: 'Cordis-Zugriff aktualisiert',
    saveFailed: 'Cordis-Zugriff konnte nicht aktualisiert werden',
    lockedByEnv: 'Durch die Umgebungsvariable LIBRE_CORDIS_ENABLED festgelegt.',
    lockedByFile: 'Durch features.enabled in cordis.config.yml festgelegt.',
    disabledHint:
      'Ein Administrator kann sie unter Benutzerverwaltung → Zugriff & Richtlinien aktivieren.',
  },
  fr: {
    title: 'Moteur Cordis',
    description:
      "Proposer le moteur Cordis aux administrateurs. Il exécute des outils avec un accès réel au système de fichiers, hors du flux d'approbation des outils de Libre WebUI.",
    saved: 'Accès à Cordis mis à jour',
    saveFailed: "Impossible de mettre à jour l'accès à Cordis",
    lockedByEnv: "Fixé par la variable d'environnement LIBRE_CORDIS_ENABLED.",
    lockedByFile: 'Fixé par features.enabled dans cordis.config.yml.',
    disabledHint:
      "Un administrateur peut l'activer dans Gestion des utilisateurs → Accès et politiques.",
  },
  es: {
    title: 'Motor Cordis',
    description:
      'Ofrecer el motor Cordis a los administradores. Ejecuta herramientas con acceso real al sistema de archivos, fuera del flujo de aprobación de herramientas de Libre WebUI.',
    saved: 'Acceso a Cordis actualizado',
    saveFailed: 'No se pudo actualizar el acceso a Cordis',
    lockedByEnv: 'Fijado por la variable de entorno LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Fijado por features.enabled en cordis.config.yml.',
    disabledHint:
      'Un administrador puede activarlo en Gestión de usuarios → Acceso y políticas.',
  },
  it: {
    title: 'Motore Cordis',
    description:
      'Offri il motore Cordis agli amministratori. Esegue strumenti con accesso reale al filesystem, al di fuori del flusso di approvazione degli strumenti di Libre WebUI.',
    saved: 'Accesso a Cordis aggiornato',
    saveFailed: "Impossibile aggiornare l'accesso a Cordis",
    lockedByEnv: "Fissato dalla variabile d'ambiente LIBRE_CORDIS_ENABLED.",
    lockedByFile: 'Fissato da features.enabled in cordis.config.yml.',
    disabledHint:
      'Un amministratore può attivarlo in Gestione utenti → Accesso e criteri.',
  },
  pt: {
    title: 'Motor Cordis',
    description:
      'Oferecer o motor Cordis aos administradores. Ele executa ferramentas com acesso real ao sistema de arquivos, fora do fluxo de aprovação de ferramentas do Libre WebUI.',
    saved: 'Acesso ao Cordis atualizado',
    saveFailed: 'Não foi possível atualizar o acesso ao Cordis',
    lockedByEnv: 'Fixado pela variável de ambiente LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Fixado por features.enabled em cordis.config.yml.',
    disabledHint:
      'Um administrador pode ativá-lo em Gerenciamento de usuários → Acesso e políticas.',
  },
  nl: {
    title: 'Cordis-engine',
    description:
      'De Cordis-engine aan beheerders aanbieden. Deze voert hulpmiddelen uit met echte toegang tot het bestandssysteem, buiten de goedkeuringsstroom van Libre WebUI.',
    saved: 'Cordis-toegang bijgewerkt',
    saveFailed: 'Cordis-toegang kon niet worden bijgewerkt',
    lockedByEnv: 'Vastgezet door de omgevingsvariabele LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Vastgezet door features.enabled in cordis.config.yml.',
    disabledHint:
      'Een beheerder kan dit inschakelen bij Gebruikersbeheer → Toegang en beleid.',
  },
  da: {
    title: 'Cordis-motor',
    description:
      'Tilbyd Cordis-motoren til administratorer. Den kører værktøjer med rigtig filsystemadgang uden for Libre WebUIs godkendelsesflow.',
    saved: 'Cordis-adgang opdateret',
    saveFailed: 'Cordis-adgang kunne ikke opdateres',
    lockedByEnv: 'Låst af miljøvariablen LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Låst af features.enabled i cordis.config.yml.',
    disabledHint:
      'En administrator kan slå det til under Brugerstyring → Adgang og politikker.',
  },
  sv: {
    title: 'Cordis-motor',
    description:
      'Erbjud Cordis-motorn till administratörer. Den kör verktyg med riktig filsystemsåtkomst utanför Libre WebUIs godkännandeflöde.',
    saved: 'Cordis-åtkomst uppdaterad',
    saveFailed: 'Cordis-åtkomsten kunde inte uppdateras',
    lockedByEnv: 'Låst av miljövariabeln LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Låst av features.enabled i cordis.config.yml.',
    disabledHint:
      'En administratör kan aktivera det under Användarhantering → Åtkomst och policyer.',
  },
  is: {
    title: 'Cordis-vél',
    description:
      'Bjóða stjórnendum Cordis-vélina. Hún keyrir verkfæri með raunverulegum aðgangi að skráarkerfinu utan samþykktarflæðis Libre WebUI.',
    saved: 'Cordis-aðgangur uppfærður',
    saveFailed: 'Ekki tókst að uppfæra Cordis-aðgang',
    lockedByEnv: 'Fest af umhverfisbreytunni LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Fest af features.enabled í cordis.config.yml.',
    disabledHint:
      'Stjórnandi getur kveikt á því í Notendastjórnun → Aðgangur og stefnur.',
  },
  pl: {
    title: 'Silnik Cordis',
    description:
      'Udostępnij silnik Cordis administratorom. Wykonuje narzędzia z rzeczywistym dostępem do systemu plików, poza przepływem zatwierdzania narzędzi Libre WebUI.',
    saved: 'Dostęp do Cordis zaktualizowany',
    saveFailed: 'Nie udało się zaktualizować dostępu do Cordis',
    lockedByEnv: 'Ustalony przez zmienną środowiskową LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Ustalony przez features.enabled w cordis.config.yml.',
    disabledHint:
      'Administrator może go włączyć w Zarządzaniu użytkownikami → Dostęp i zasady.',
  },
  cs: {
    title: 'Modul Cordis',
    description:
      'Nabídněte modul Cordis správcům. Spouští nástroje se skutečným přístupem k souborovému systému mimo schvalovací tok nástrojů Libre WebUI.',
    saved: 'Přístup k Cordis aktualizován',
    saveFailed: 'Přístup k Cordis se nepodařilo aktualizovat',
    lockedByEnv: 'Pevně nastaveno proměnnou prostředí LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Pevně nastaveno přes features.enabled v cordis.config.yml.',
    disabledHint:
      'Správce jej může zapnout ve Správě uživatelů → Přístup a zásady.',
  },
  ru: {
    title: 'Движок Cordis',
    description:
      'Предложить движок Cordis администраторам. Он выполняет инструменты с реальным доступом к файловой системе вне процесса утверждения инструментов Libre WebUI.',
    saved: 'Доступ к Cordis обновлён',
    saveFailed: 'Не удалось обновить доступ к Cordis',
    lockedByEnv: 'Зафиксировано переменной среды LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Зафиксировано features.enabled в cordis.config.yml.',
    disabledHint:
      'Администратор может включить его в разделе «Управление пользователями» → «Доступ и политики».',
  },
  uk: {
    title: 'Рушій Cordis',
    description:
      'Запропонувати рушій Cordis адміністраторам. Він виконує інструменти з реальним доступом до файлової системи поза процесом затвердження інструментів Libre WebUI.',
    saved: 'Доступ до Cordis оновлено',
    saveFailed: 'Не вдалося оновити доступ до Cordis',
    lockedByEnv: 'Зафіксовано змінною середовища LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Зафіксовано features.enabled у cordis.config.yml.',
    disabledHint:
      'Адміністратор може увімкнути його в розділі «Керування користувачами» → «Доступ і політики».',
  },
  tr: {
    title: 'Cordis Motoru',
    description:
      'Cordis motorunu yöneticilere sunun. Araçları, Libre WebUI araç onay akışının dışında gerçek dosya sistemi erişimiyle çalıştırır.',
    saved: 'Cordis erişimi güncellendi',
    saveFailed: 'Cordis erişimi güncellenemedi',
    lockedByEnv: 'LIBRE_CORDIS_ENABLED ortam değişkeniyle sabitlendi.',
    lockedByFile: 'cordis.config.yml içindeki features.enabled ile sabitlendi.',
    disabledHint:
      'Bir yönetici bunu Kullanıcı Yönetimi → Erişim ve ilkeler altında açabilir.',
  },
  ar: {
    title: 'محرك Cordis',
    description:
      'إتاحة محرك Cordis للمسؤولين. فهو ينفّذ الأدوات بوصول حقيقي إلى نظام الملفات خارج مسار الموافقة على الأدوات في Libre WebUI.',
    saved: 'تم تحديث الوصول إلى Cordis',
    saveFailed: 'تعذّر تحديث الوصول إلى Cordis',
    lockedByEnv: 'مثبّت بواسطة متغير البيئة LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'مثبّت بواسطة features.enabled في cordis.config.yml.',
    disabledHint: 'يمكن للمسؤول تفعيله من إدارة المستخدمين ← الوصول والسياسات.',
  },
  hi: {
    title: 'कॉर्डिस इंजन',
    description:
      'कॉर्डिस इंजन प्रशासकों को उपलब्ध कराएँ। यह टूल को वास्तविक फ़ाइलसिस्टम पहुँच के साथ चलाता है, Libre WebUI के टूल अनुमोदन प्रवाह के बाहर।',
    saved: 'कॉर्डिस पहुँच अपडेट की गई',
    saveFailed: 'कॉर्डिस पहुँच अपडेट नहीं की जा सकी',
    lockedByEnv: 'LIBRE_CORDIS_ENABLED पर्यावरण चर द्वारा निर्धारित।',
    lockedByFile: 'cordis.config.yml में features.enabled द्वारा निर्धारित।',
    disabledHint:
      'प्रशासक इसे उपयोगकर्ता प्रबंधन → पहुँच और नीतियाँ में सक्षम कर सकता है।',
  },
  bn: {
    title: 'কর্ডিস ইঞ্জিন',
    description:
      'প্রশাসকদের জন্য কর্ডিস ইঞ্জিন চালু করুন। এটি Libre WebUI-এর টুল অনুমোদন প্রবাহের বাইরে প্রকৃত ফাইলসিস্টেম অ্যাক্সেস নিয়ে টুল চালায়।',
    saved: 'কর্ডিস অ্যাক্সেস আপডেট হয়েছে',
    saveFailed: 'কর্ডিস অ্যাক্সেস আপডেট করা যায়নি',
    lockedByEnv: 'LIBRE_CORDIS_ENABLED পরিবেশ ভেরিয়েবল দ্বারা নির্ধারিত।',
    lockedByFile: 'cordis.config.yml-এ features.enabled দ্বারা নির্ধারিত।',
    disabledHint:
      'একজন প্রশাসক এটি ব্যবহারকারী ব্যবস্থাপনা → অ্যাক্সেস ও নীতি-তে সক্রিয় করতে পারেন।',
  },
  id: {
    title: 'Mesin Cordis',
    description:
      'Tawarkan mesin Cordis kepada administrator. Mesin ini menjalankan alat dengan akses sistem berkas nyata di luar alur persetujuan alat Libre WebUI.',
    saved: 'Akses Cordis diperbarui',
    saveFailed: 'Tidak dapat memperbarui akses Cordis',
    lockedByEnv: 'Dikunci oleh variabel lingkungan LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Dikunci oleh features.enabled di cordis.config.yml.',
    disabledHint:
      'Administrator dapat mengaktifkannya di Manajemen Pengguna → Akses & kebijakan.',
  },
  ms: {
    title: 'Enjin Cordis',
    description:
      'Tawarkan enjin Cordis kepada pentadbir. Ia menjalankan alat dengan akses sistem fail sebenar di luar aliran kelulusan alat Libre WebUI.',
    saved: 'Akses Cordis dikemas kini',
    saveFailed: 'Akses Cordis tidak dapat dikemas kini',
    lockedByEnv:
      'Ditetapkan oleh pemboleh ubah persekitaran LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Ditetapkan oleh features.enabled dalam cordis.config.yml.',
    disabledHint:
      'Pentadbir boleh mendayakannya dalam Pengurusan Pengguna → Akses & dasar.',
  },
  th: {
    title: 'เอนจิน Cordis',
    description:
      'เปิดให้ผู้ดูแลระบบใช้เอนจิน Cordis ซึ่งเรียกใช้เครื่องมือด้วยการเข้าถึงไฟล์จริงนอกขั้นตอนอนุมัติเครื่องมือของ Libre WebUI',
    saved: 'อัปเดตการเข้าถึง Cordis แล้ว',
    saveFailed: 'ไม่สามารถอัปเดตการเข้าถึง Cordis ได้',
    lockedByEnv: 'ถูกกำหนดโดยตัวแปรสภาพแวดล้อม LIBRE_CORDIS_ENABLED',
    lockedByFile: 'ถูกกำหนดโดย features.enabled ใน cordis.config.yml',
    disabledHint:
      'ผู้ดูแลระบบสามารถเปิดได้ที่ การจัดการผู้ใช้ → การเข้าถึงและนโยบาย',
  },
  vi: {
    title: 'Công cụ Cordis',
    description:
      'Cung cấp công cụ Cordis cho quản trị viên. Nó chạy công cụ với quyền truy cập hệ thống tệp thực, nằm ngoài luồng phê duyệt công cụ của Libre WebUI.',
    saved: 'Đã cập nhật quyền truy cập Cordis',
    saveFailed: 'Không thể cập nhật quyền truy cập Cordis',
    lockedByEnv: 'Được ghim bởi biến môi trường LIBRE_CORDIS_ENABLED.',
    lockedByFile: 'Được ghim bởi features.enabled trong cordis.config.yml.',
    disabledHint:
      'Quản trị viên có thể bật trong Quản lý người dùng → Quyền truy cập và chính sách.',
  },
  ja: {
    title: 'Cordis エンジン',
    description:
      'Cordis エンジンを管理者に提供します。Libre WebUI のツール承認フローの外で、実際のファイルシステムアクセスを伴うツールを実行します。',
    saved: 'Cordis アクセスを更新しました',
    saveFailed: 'Cordis アクセスを更新できませんでした',
    lockedByEnv: '環境変数 LIBRE_CORDIS_ENABLED によって固定されています。',
    lockedByFile:
      'cordis.config.yml の features.enabled によって固定されています。',
    disabledHint:
      '管理者は「ユーザー管理」→「アクセスとポリシー」で有効にできます。',
  },
  ko: {
    title: 'Cordis 엔진',
    description:
      '관리자에게 Cordis 엔진을 제공합니다. Libre WebUI의 도구 승인 흐름 밖에서 실제 파일 시스템 접근으로 도구를 실행합니다.',
    saved: 'Cordis 접근이 업데이트되었습니다',
    saveFailed: 'Cordis 접근을 업데이트하지 못했습니다',
    lockedByEnv: 'LIBRE_CORDIS_ENABLED 환경 변수로 고정되었습니다.',
    lockedByFile: 'cordis.config.yml의 features.enabled로 고정되었습니다.',
    disabledHint:
      '관리자는 사용자 관리 → 접근 및 정책에서 활성화할 수 있습니다.',
  },
  zh: {
    title: 'Cordis 引擎',
    description:
      '向管理员提供 Cordis 引擎。它在 Libre WebUI 的工具审批流程之外，以真实的文件系统访问权限运行工具。',
    saved: 'Cordis 访问权限已更新',
    saveFailed: '无法更新 Cordis 访问权限',
    lockedByEnv: '由环境变量 LIBRE_CORDIS_ENABLED 固定。',
    lockedByFile: '由 cordis.config.yml 中的 features.enabled 固定。',
    disabledHint: '管理员可在“用户管理”→“访问与策略”中启用。',
  },
};
