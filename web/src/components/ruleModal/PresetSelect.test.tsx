import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import PresetSelect from './PresetSelect'
import { type PresetItem } from '../../lib/api'

const presets: PresetItem[] = [
  {
    key: 'genre',
    name: 'Genre',
    description: 'One subfolder per genre.',
    category: 'genre',
    match_type: 'regex',
    match_value: '.+',
    source: 'native',
    subpath: '/{$genre}',
    default_base_folder: '/media/movies',
    dir_template: '/media/movies/{$genre}',
  },
]

describe('PresetSelect', () => {
  it('fires onSelect when a preset option is clicked', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<PresetSelect presets={presets} onSelect={onSelect} />)

    await user.click(screen.getByRole('button'))
    const option = await screen.findByText('Genre')
    await user.click(option)

    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith(presets[0])
  })
})
