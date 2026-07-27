<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, toRaw } from "vue";
import { compressionFile, handleImgZoom } from "~/utils/tools";

const input = ref('')
const addHistory = ref(true)
const fileList = ref<{
  file: File
  url: string
}[]>([])
const { openModelSelect } = useGlobalState()

onMounted(() => {
  addHistory.value = localStorage.getItem('addHistory') === 'true'
})
watch(addHistory, () => {
  localStorage.setItem('addHistory', addHistory.value.toString())
})

const p = defineProps<{
  loading: boolean
  selectedModel: Model

  handleSend: (input: string, addHistory: boolean, files: {
    file: File
    url: string
  }[]) => void
}>()

function handleInput(e: any) {
  // 兼容回车和鼠标点击事件
  if (e && e.type === 'keydown') {
    if (e.shiftKey) {
      input.value += '\n'
      return
    }
    if (e.isComposing) {
      return
    }
  }

  if (input.value.trim() === '') return
  if (p.loading) return
  
  // 发送数据
  p.handleSend(input.value, addHistory.value, toRaw(fileList.value))
  input.value = ''
  fileList.value = []
}

function checkFile(file: File) {
  if (fileList.value.length >= 5) {
    alert('You can only upload up to 5 files')
    return false
  }
  return true
}

function handleAddFiles() {
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = '*' // 允许任意格式
  fileInput.multiple = true
  fileInput.onchange = async () => {
    document.body.style.cursor = 'wait'

    const files = Array.from(fileInput.files || [])
    for (const f of files) {
      if (!checkFile(f)) continue;
      
      let file = f;
      // 增加安全校验：确保 f.type 存在
      if (f.type && f.type.startsWith('image/')) {
        try {
          file = await compressionFile(f, f.type)
        } catch (e) {
          console.error('图片压缩失败:', e)
        }
      }

      const url = URL.createObjectURL(file)
      fileList.value.push({file, url})
    }

    document.body.style.cursor = 'auto'
  }
  fileInput.click()
}

onUnmounted(() => {
  fileList.value.forEach(i => {
    URL.revokeObjectURL(i.url)
  })
})

const handlePaste = (e: ClipboardEvent) => {
  const files = Array.from(e.clipboardData?.files || [])
  files.forEach(file => {
    if (!checkFile(file)) return

    const url = URL.createObjectURL(file)
    fileList.value.push({file, url})
  })
}
</script>

<template>
  <div class="relative">
    <div class="absolute bottom-10 w-full flex flex-col">
      <UButton class="self-center drop-shadow-xl mb-1 blur-global" color="white"
               @click="openModelSelect=!openModelSelect">
        {{ selectedModel?.name || 'Model' }}
        <template #trailing>
          <UIcon name="i-heroicons-chevron-down-solid"/>
        </template>
      </UButton>
      <ul v-if="selectedModel?.type === 'universal'" style="margin: 0"
          class="flex flex-wrap bg-white dark:bg-[#121212] rounded-t-md">
        <li v-for="file in fileList" :key="file.url" class="relative group/img flex items-center">
          <button @click="fileList.splice(fileList.indexOf(file), 1)"
                  class="absolute z-10 hidden group-hover/img:block rounded-full bg-neutral-100 right-0 top-0 hover:brightness-75 dark:bg-[#121212] transition-all">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 16 16">
              <path fill="currentColor"
                    d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94z"/>
            </svg>
          </button>
          
          <!-- 核心修复点：加入 `?.` 防御空引用渲染报错 -->
          <img v-if="file?.file?.type && file.file.type.startsWith('image/')" :src="file.url"
               class="max-h-16 m-1 shadow-xl cursor-pointer group-hover/img:brightness-75 transition-all rounded-md"
               alt="selected image" @click="handleImgZoom($event.target as HTMLImageElement)"/>
          
          <div v-else class="max-h-16 m-1 p-2 bg-gray-100 dark:bg-gray-800 rounded-md flex items-center text-xs space-x-1 border border-gray-200 dark:border-gray-700">
            <UIcon name="i-heroicons-document-text-solid" class="w-5 h-5 text-primary-500" />
            <span class="max-w-[100px] truncate">{{ file?.file?.name || '附件' }}</span>
          </div>
        </li>
      </ul>
    </div>
    <div class="flex items-end">
      <UTooltip :text="addHistory?$t('with_history'):$t('without_history')">
        <UButton class="m-1" @click="addHistory = !addHistory" :color="addHistory?'primary':'gray'"
                 icon="i-heroicons-clock-solid"/>
      </UTooltip>
      <UTooltip v-if="selectedModel?.type === 'universal'" :text="$t('add_image') + '(' + $t('support_paste') + ')'">
        <UButton @click="handleAddFiles" color="white" class="m-1" icon="i-heroicons-paper-clip-16-solid"/>
      </UTooltip>
      <UTextarea v-model="input" :placeholder="$t('please_input_text') + '...' "
                 @keydown.prevent.enter="handleInput($event)"
                 @paste="handlePaste"
                 autofocus :rows="1" autoresize
                 class="flex-1 max-h-48 overflow-y-auto p-1"/>
      <UButton @click="handleInput($event)" :disabled="loading" class="m-1">
        {{ $t('send') }}
      </UButton>
    </div>
  </div>
</template>
