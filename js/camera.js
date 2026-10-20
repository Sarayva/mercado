/* ==========================================================================
   Módulo de Câmera e Compressão de Imagens - Meu Mercado PWA
   Abre a câmera nativa do celular (traseira) e comprime a foto para a IA
   ========================================================================== */

/**
 * Abre a câmera do celular para fotografar a etiqueta de preço.
 * Utiliza o input capture="environment" nativo que garante foco e alta resolução no celular.
 * Retorna uma Promise com a imagem comprimida em formato Base64 (DataURL).
 */
export function capturePriceTagPhoto() {
  return new Promise((resolve, reject) => {
    // Cria um input invisível configurado para acionar a câmera traseira
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.style.display = 'none';

    input.onchange = async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) {
        reject(new Error('Nenhuma foto foi capturada.'));
        input.remove();
        return;
      }

      try {
        // Redimensiona e comprime a foto para envio instantâneo para a IA (~15KB - 30KB)
        const compressedDataUrl = await compressImageFile(file, 640, 0.65);
        input.remove();
        resolve({
          file,
          dataUrl: compressedDataUrl
        });
      } catch (err) {
        input.remove();
        reject(err);
      }
    };

    // Caso o usuário cancele
    window.addEventListener('focus', () => {
      setTimeout(() => {
        if (!input.files || input.files.length === 0) {
          // Pequeno timeout caso o usuário tenha fechado a câmera sem bater a foto
          input.remove();
        }
      }, 1000);
    }, { once: true });

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Comprime e redimensiona um arquivo de imagem via Canvas HTML5
 * Evita enviar fotos pesadas de 5MB do celular para a nuvem
 */
function compressImageFile(file, maxDimension = 640, quality = 0.65) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      const img = new Image();

      img.onload = () => {
        let width = img.width;
        let height = img.height;

        // Mantém a proporção redimensionando para o limite máximo
        if (width > height) {
          if (width > maxDimension) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          }
        } else {
          if (height > maxDimension) {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        // Renderiza com interpolação de alta qualidade
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        // Exporta como JPEG com compressão
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl);
      };

      img.onerror = () => reject(new Error('Erro ao decodificar a foto capturada.'));
      img.src = e.target.result;
    };

    reader.onerror = () => reject(new Error('Erro ao ler o arquivo da câmera.'));
    reader.readAsDataURL(file);
  });
}
